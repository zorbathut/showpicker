import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { syncCreate } from "../../app/static/sync.js";

// Edits whose PUT a test leaves unanswered never settle; route them through here so any rejection still fails the test.
const rejections = [];
function pending(promise) {
  promise.catch((e) => rejections.push(e));
  return promise;
}
afterEach(() => {
  assert.deepEqual(rejections.splice(0), []);
});

// A transport whose requests stay pending until the test answers them, so interleavings can be scripted.
function fakeServer() {
  const pending = [];
  const transport = (method, path, body) =>
    new Promise((resolve, reject) => {
      pending.push({ method, path, body, resolve, reject });
    });
  return {
    transport,
    pending,
    async answer(status, body) {
      const req = pending.shift();
      assert.ok(req, "no request pending");
      req.resolve({ status, body });
      await flush();
      return req;
    },
    async fail() {
      const req = pending.shift();
      req.reject(new TypeError("Failed to fetch"));
      await flush();
      return req;
    },
  };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function recorder() {
  const events = [];
  return {
    events,
    callbacks: {
      onAdopt: (keys) => events.push(["adopt", [...keys]]),
      onConflict: () => events.push(["conflict"]),
      onRefused: (message) => events.push(["refused", message]),
      onConnection: (ok) => events.push(["connection", ok]),
    },
  };
}

const START = { instance: "i1", version: 5, keys: ["tmdb:movie:1"] };

function setup() {
  const server = fakeServer();
  const rec = recorder();
  const sync = syncCreate(server.transport, rec.callbacks);
  sync.start(START);
  return { server, rec, sync };
}

test("an edit PUTs the new keys with the stamp it was based on", async () => {
  const { server, rec, sync } = setup();
  const done = sync.edit(["tmdb:movie:1", "tmdb:movie:2"]);
  const req = server.pending[0];
  assert.deepEqual([req.method, req.body], ["PUT", { base_instance: "i1", base_version: 5, keys: ["tmdb:movie:1", "tmdb:movie:2"] }]);
  await server.answer(200, { instance: "i1", version: 6, keys: req.body.keys });
  assert.equal(await done, true);
  assert.deepEqual(rec.events, []);
});

test("edits made while a PUT is in flight coalesce into one more PUT of the latest keys", async () => {
  const { server, sync } = setup();
  pending(sync.edit(["a"]));
  pending(sync.edit(["a", "b"]));
  pending(sync.edit(["a", "b", "c"]));
  assert.equal(server.pending.length, 1);
  await server.answer(200, { instance: "i1", version: 6, keys: ["a"] });
  assert.equal(server.pending.length, 1);
  assert.deepEqual(server.pending[0].body, { base_instance: "i1", base_version: 6, keys: ["a", "b", "c"] });
  await server.answer(200, { instance: "i1", version: 7, keys: ["a", "b", "c"] });
  assert.equal(server.pending.length, 0);
});

test("a 409 adopts the server's lineup and reports the conflict", async () => {
  const { server, rec, sync } = setup();
  pending(sync.edit(["mine"]));
  await server.answer(409, { instance: "i1", version: 6, keys: ["theirs"] });
  assert.deepEqual(rec.events, [["adopt", ["theirs"]], ["conflict"]]);
  assert.deepEqual(sync.keys(), ["theirs"]);
  pending(sync.edit(["theirs", "next"]));
  assert.equal(server.pending[0].body.base_version, 6);
});

test("a 409 whose keys match what this screen wanted is not reported as a conflict", async () => {
  const { server, rec, sync } = setup();
  pending(sync.edit(["same"]));
  await server.answer(409, { instance: "i1", version: 6, keys: ["same"] });
  assert.deepEqual(rec.events, []);
});

test("a poll that left before a local edit is dropped", async () => {
  const { server, rec, sync } = setup();
  const polled = sync.poll();
  pending(sync.edit(["mine"]));
  // The GET is answered with the pre-edit state at a newer version (another screen's edit), then the PUT conflicts.
  await server.answer(200, { instance: "i1", version: 6, keys: ["old"] });
  await polled;
  assert.deepEqual(rec.events, []);
  assert.deepEqual(sync.keys(), ["mine"]);
});

test("a poll that lands while a PUT is in flight is dropped", async () => {
  const { server, rec, sync } = setup();
  pending(sync.edit(["mine"]));
  const polled = sync.poll();
  const get = server.pending[1];
  server.pending.splice(1, 1);
  get.resolve({ status: 200, body: { instance: "i1", version: 9, keys: ["other"] } });
  await polled;
  assert.deepEqual(rec.events, []);
  await server.answer(200, { instance: "i1", version: 6, keys: ["mine"] });
  assert.deepEqual(sync.keys(), ["mine"]);
});

test("polls adopt newer versions and other instances, and ignore the current or older versions", async () => {
  const { server, rec, sync } = setup();
  for (const [version, instance, keys, adopted] of [
    [5, "i1", ["x"], false],
    [4, "i1", ["x"], false],
    [6, "i1", ["newer"], true],
    [0, "i2", [], true],
  ]) {
    const polled = sync.poll();
    await server.answer(200, { instance, version, keys });
    await polled;
    assert.equal(rec.events.length > 0, adopted, `version ${version} on ${instance}`);
    rec.events.length = 0;
  }
  assert.deepEqual(sync.keys(), []);
});

test("a PUT that fails on the network is retried by the next poll, and connectivity is reported once each way", async () => {
  const { server, rec, sync } = setup();
  const done = sync.edit(["mine"]);
  await server.fail();
  assert.equal(await done, false);
  let polled = sync.poll();
  assert.equal(server.pending[0].method, "PUT");
  await server.fail();
  await polled;
  assert.deepEqual(rec.events, [["connection", false]]);
  polled = sync.poll();
  await server.answer(200, { instance: "i1", version: 6, keys: ["mine"] });
  await polled;
  assert.deepEqual(rec.events, [
    ["connection", false],
    ["connection", true],
  ]);
  polled = sync.poll();
  assert.equal(server.pending[0].method, "GET");
});

test("a refused edit is reported and the server's lineup is taken on the next poll even at the same version", async () => {
  const { server, rec, sync } = setup();
  pending(sync.edit(["tmdb:movie:1", "bogus"]));
  await server.answer(400, { detail: "Not a valid title key: 'bogus'" });
  assert.deepEqual(rec.events, [["refused", "Not a valid title key: 'bogus'"]]);
  const polled = sync.poll();
  await server.answer(200, START);
  await polled;
  assert.deepEqual(rec.events.at(-1), ["adopt", ["tmdb:movie:1"]]);
});

test("a server error on PUT is retried rather than adopted over", async () => {
  const { server, sync } = setup();
  pending(sync.edit(["mine"]));
  await server.answer(502, { detail: "Bad Gateway" });
  const polled = sync.poll();
  assert.deepEqual(server.pending[0].body.keys, ["mine"]);
  await server.answer(200, { instance: "i1", version: 6, keys: ["mine"] });
  await polled;
});

test("GET failures report a lost connection once until a poll succeeds", async () => {
  const { server, rec, sync } = setup();
  for (let i = 0; i < 3; i++) {
    const polled = sync.poll();
    await server.fail();
    await polled;
  }
  const polled = sync.poll();
  await server.answer(200, START);
  await polled;
  assert.deepEqual(rec.events, [
    ["connection", false],
    ["connection", true],
  ]);
});
