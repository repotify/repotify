// P2: tokenizer tests — real BPE for English, language-normalized for Turkish.
// Validates: (1) deterministic sane counts, (2) Turkish bias is REDUCED vs
// char-counting on parallel EN/TR text (the critic's finding).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { countTokens } from "../lib/tokenizer.mjs";

test("countTokens is deterministic and positive", () => {
  const a = countTokens("Provides domain-specific intelligence for a project niche.");
  const b = countTokens("Provides domain-specific intelligence for a project niche.");
  assert.equal(a, b);
  assert.ok(a > 0);
  assert.equal(countTokens(""), 0);
});

test("English compresses at ~4 chars/token (real subword behavior)", () => {
  const text = "Guides a coding agent through designing, validating, and documenting an A/B test.";
  const cpt = text.length / countTokens(text);
  assert.ok(cpt > 2.5 && cpt < 6.5, `chars/token=${cpt}`);
});

test("Turkish bias is reduced vs char-counting (parallel EN/TR)", () => {
  // Same meaning, both languages. Char counting penalizes Turkish ~1.3x;
  // the language-aware tokenizer must be closer to 1.0 than chars are.
  const pairs = [
    ["We collect user feedback regularly.", "Kullanıcı geri bildirimlerini düzenli olarak topluyoruz."],
    ["The system measures results.", "Sistem sonuçları ölçüyor."],
    ["Security tools are integrated.", "Güvenlik araçları entegre edildi."],
    ["Users expect fast responses.", "Kullanıcılar hızlı yanıt bekliyorlar."],
    ["Tests run automatically.", "Testler otomatik çalışıyor."],
  ];
  let tokBias = 0;
  let charBias = 0;
  for (const [en, tr] of pairs) {
    const ratio = countTokens(tr) / countTokens(en);
    tokBias += Math.abs(ratio - 1);
    charBias += Math.abs(tr.length / en.length - 1);
  }
  tokBias /= pairs.length;
  charBias /= pairs.length;
  assert.ok(
    tokBias < charBias,
    `token bias ${tokBias.toFixed(3)} should be < char bias ${charBias.toFixed(3)}`,
  );
});

test("Turkish text does not fragment punitively", () => {
  // A Turkish sentence should not cost 2x the tokens of its English meaning.
  const tr = "Kullanıcı geri bildirimlerini düzenli olarak topluyoruz.";
  const en = "We collect user feedback regularly.";
  const ratio = countTokens(tr) / countTokens(en);
  assert.ok(ratio < 1.5, `tr/en token ratio=${ratio}`);
});
