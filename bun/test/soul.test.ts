import { describe, test, expect } from "bun:test";
import { SoulAdapter, BOOTSTRAP_DOCTRINE } from "../src/soul";

test("soul adapter loads the three files hot", () => {
  const s = new SoulAdapter();
  expect(s.exists()).toBe(true);
  const soul = s.load();
  expect(soul.soulMd).toContain("kite");
  expect(soul.memoriesMd).toContain("worthless");
  expect(soul.identity?.agent_id).toBe("kite");
  expect(soul.identity?.summoner).toBe("Chris");
});

test("bootstrap injects the doctrine", () => {
  const soul = new SoulAdapter().load();
  expect(soul.bootstrap).toContain(BOOTSTRAP_DOCTRINE.split("\n")[0]);
  expect(soul.bootstrap).toContain("WORTHLESS");
});

test("remember() is idempotent", () => {
  const dir = `${import.meta.dir}/.tmp-soul-test-${Date.now()}`;
  const s = new SoulAdapter(dir);
  const line = "test-memory-idempotency-check";
  expect(s.remember(line)).toBe(true);   // first write lands
  expect(s.remember(line)).toBe(false);  // replay is a no-op — the idempotency contract
});
