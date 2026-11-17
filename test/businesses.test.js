import test from "node:test";
import assert from "node:assert/strict";
import { BusinessRegistry, BusinessError, normalizeSlug, validateBusiness, SLUG_RE } from "../src/businesses.js";
import { PLACE_ID } from "./helpers.js";

test("normalizeSlug lowercases and trims", () => {
  assert.equal(normalizeSlug("  Moms-Originals "), "moms-originals");
  assert.equal(normalizeSlug(undefined), "");
});

test("slug rules accept sensible slugs and reject others", () => {
  for (const ok of ["a", "moms-originals", "shop2", "a1-b2-c3"]) assert.ok(SLUG_RE.test(ok), ok);
  for (const bad of ["", "-lead", "trail-", "UPPER", "has space", "under_score", "a".repeat(41)]) {
    assert.equal(SLUG_RE.test(bad), false, bad);
  }
});

test("validateBusiness fills defaults and trims values", () => {
  const b = validateBusiness(" Moms-Originals ", { placeId: ` ${PLACE_ID} ` });
  assert.equal(b.slug, "moms-originals");
  assert.equal(b.placeId, PLACE_ID);
  assert.equal(b.label, "moms-originals"); // falls back to slug
  assert.equal(b.language, undefined);
});

test("validateBusiness rejects an invalid place id", () => {
  assert.throws(() => validateBusiness("shop", { placeId: "abc" }), BusinessError);
  assert.throws(() => validateBusiness("shop", {}), BusinessError);
});

test("validateBusiness rejects a bad slug", () => {
  assert.throws(() => validateBusiness("Moms Originals", { placeId: PLACE_ID }), BusinessError);
});

test("registry looks up case-insensitively and lists without secrets", () => {
  const reg = new BusinessRegistry({
    "moms-originals": { placeId: PLACE_ID, label: "Moms Originals" },
    second: { placeId: "ChIJrTLr-GyuEmsRBfy61i59si0", label: "Second Shop" },
  });
  assert.equal(reg.size, 2);
  assert.equal(reg.get("MOMS-ORIGINALS").label, "Moms Originals");
  assert.equal(reg.get("missing"), null);
  assert.deepEqual(reg.list(), [
    { slug: "moms-originals", label: "Moms Originals" },
    { slug: "second", label: "Second Shop" },
  ]);
});

test("registry refuses an empty configuration", () => {
  assert.throws(() => new BusinessRegistry({}), BusinessError);
});
