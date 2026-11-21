import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeText, createSearchIndex, searchRecipes } from "../lib/search.mjs";

const book = JSON.parse(await readFile(new URL("../data/book.json", import.meta.url), "utf8"));
const index = createSearchIndex(book);
const ids = (recipes) => recipes.map((recipe) => recipe.id);

test("normalization removes Vietnamese tones, handles đ and punctuation", () => {
  assert.equal(normalizeText("  ĐẶNG ĐÌNH, lá DÂU – 20g. "), "dang dinh la dau 20g");
  assert.equal(normalizeText("đa\u0300o"), "dao");
  assert.equal(normalizeText(null), "");
  assert.equal(normalizeText(12), "12");
});

test("blank and punctuation-only queries keep all recipes in book order", () => {
  const expected = [...book.recipes].sort((a, b) => a.ordinal - b.ordinal);
  assert.deepEqual(searchRecipes(index), expected);
  assert.deepEqual(searchRecipes(index, { query: " \n ; ?! -- “ ” " }), expected);
  assert.equal(expected.length, 263);
  assert.equal(searchRecipes(index)[0], book.recipes[0], "return original object references");
});

test("accented and accentless queries give the same matches", () => {
  const query = '"cao huyet ap"';
  const actual = searchRecipes(index, { query });
  assert.deepEqual(ids(actual), ids(searchRecipes(index, { query: '"cao huyết áp"' })));
  assert.equal(actual.length, 10);
  assert.ok(actual.some((recipe) => recipe.id === "tim-mach-002"));
});

test("query tokens combine with AND, including a numeric quantity", () => {
  const result = searchRecipes(index, { query: "hat sen 12g", mode: "ingredients" });
  assert.ok(result.some((recipe) => recipe.id === "tim-mach-008"));
  assert.ok(result.every((recipe) => {
    const text = normalizeText(recipe.ingredients.map((item) => `${item.name} ${item.quantity}`).join(" "));
    return ["hat", "sen", "12g"].every((token) => text.includes(token));
  }));
  assert.equal(searchRecipes(index, { query: "hat sen qzxnonexistent", mode: "ingredients" }).length, 0);
});

test("ingredient mode does not match dosage or usage prose", () => {
  const fixture = {
    recipes: [
      { id: "dose", ordinal: 1, categoryId: "a", ingredients: [{ name: "Rau má", quantity: "20g" }], sections: [{ kind: "dosage", text: "Hạt sen ngày 2 lần" }], sourceText: "Hạt sen ngày 2 lần" },
      { id: "ingredient", ordinal: 2, categoryId: "b", ingredients: [{ name: "Hạt sen", quantity: "12g" }], sections: [{ kind: "uses", text: "Công dụng riêng" }], sourceText: "Hạt sen 12g" },
    ],
  };
  const fixtureIndex = createSearchIndex(fixture);
  assert.deepEqual(ids(searchRecipes(fixtureIndex, { query: "hat sen", mode: "ingredients" })), ["ingredient"]);
  assert.equal(searchRecipes(fixtureIndex, { query: "ngay", mode: "ingredients" }).length, 0);
  assert.deepEqual(ids(searchRecipes(fixtureIndex, { query: "ngay", mode: "all" })), ["dose"]);
  assert.deepEqual(ids(searchRecipes(fixtureIndex, { query: "cong dung rieng", mode: "uses" })), ["ingredient"]);
  assert.equal(searchRecipes(fixtureIndex, { query: "hat sen", mode: "uses" }).length, 0);
});

test("category, subgroup and favorites compose without conflating recipe numbers", () => {
  const options = { query: '"bai thuoc so 2"', categoryId: "gan", subcategoryId: "gan-s02", sort: "book" };
  assert.deepEqual(ids(searchRecipes(index, options)), ["gan-003", "gan-004"]);
  assert.deepEqual(ids(searchRecipes(index, { ...options, favoriteIds: new Set(["gan-004"]) })), ["gan-004"]);
  assert.deepEqual(ids(searchRecipes(index, { ...options, favoriteIds: ["gan-003"] })), ["gan-003"]);
  assert.deepEqual(searchRecipes(index, { ...options, favoriteIds: [] }), []);
  assert.deepEqual(searchRecipes(index, { ...options, categoryId: "tim-mach" }), []);
});

test("uses mode includes category and subgroup while ingredient mode excludes them", () => {
  const fixtureIndex = createSearchIndex({
    categories: [{ id: "cat", name: "Hô hấp" }],
    subcategories: [{ id: "sub", name: "Hen phế quản" }],
    recipes: [{ id: "r", ordinal: 1, categoryId: "cat", subcategoryId: "sub", ingredients: [{ name: "Gừng", quantity: "4g" }], sections: [] }],
  });
  assert.deepEqual(ids(searchRecipes(fixtureIndex, { query: "ho hap hen phe quan", mode: "uses" })), ["r"]);
  assert.equal(searchRecipes(fixtureIndex, { query: "hen", mode: "ingredients" }).length, 0);
});

test("relevance favors a direct ingredient or use match over incidental source text", () => {
  const fixtureIndex = createSearchIndex({
    recipes: [
      { id: "incidental", ordinal: 1, sourceText: "Nhận xét nhắc đến rau má", ingredients: [], sections: [] },
      { id: "direct", ordinal: 2, sourceText: "Rau má", ingredients: [{ name: "Rau má", quantity: "20g" }], sections: [] },
      { id: "uses", ordinal: 3, sourceText: "Rau má", ingredients: [], sections: [{ kind: "uses", text: "Rau má theo nguồn" }] },
    ],
  });
  assert.deepEqual(ids(searchRecipes(fixtureIndex, { query: "rau ma" })), ["direct", "uses", "incidental"]);
  assert.deepEqual(ids(searchRecipes(fixtureIndex, { query: "rau ma", sort: "book" })), ["incidental", "direct", "uses"]);
});

test("quoted phrases are contiguous and unquoted words allow partial typing", () => {
  const fixtureIndex = createSearchIndex({ recipes: [
    { id: "together", ordinal: 2, sourceText: "lá dâu tằm" },
    { id: "apart", ordinal: 1, sourceText: "lá khô và quả dâu tằm" },
  ] });
  assert.deepEqual(ids(searchRecipes(fixtureIndex, { query: '“la dau”' })), ["together"]);
  assert.deepEqual(ids(searchRecipes(fixtureIndex, { query: "la da", sort: "book" })), ["apart", "together"]);
});

test("actual book ingredient phrase and source-order results are reliable", () => {
  assert.deepEqual(ids(searchRecipes(index, { query: '"hat sen"', mode: "ingredients", sort: "book" })), [
    "tim-mach-008", "truyen-nhiem-015", "tieu-hoa-024",
  ]);
  const selected = searchRecipes(index, { categoryId: "tieu-hoa", sort: "book" });
  assert.equal(selected.length, 50);
  assert.ok(selected.every((recipe, position) => position === 0 || recipe.ordinal > selected[position-1].ordinal));
});

test("empty indexes and unknown modes are handled without errors", () => {
  assert.deepEqual(searchRecipes(createSearchIndex()), []);
  assert.deepEqual(searchRecipes(null, { query: "a" }), []);
  assert.deepEqual(searchRecipes(index, { query: "hat sen", mode: "unknown" }), searchRecipes(index, { query: "hat sen", mode: "all" }));
});
