import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, promptBudget, checkPromptBudget, budgetMessage } from '../apps/linkage/budget.js';

test('estimates CJK-heavy prompts close to a real tokenizer count', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(undefined), 0);
    // 4 CJK characters and 8 ASCII characters.
    assert.equal(estimateTokens('人物资料{"id":1}'), Math.ceil(4 * 0.85 + 8 / 2.8));
});

test('reads the prompt budget for chat and text completion hosts', () => {
    assert.equal(promptBudget({ mainApi: 'openai', chatCompletionSettings: { openai_max_context: 4095, openai_max_tokens: 300 } }), 3795);
    assert.equal(promptBudget({ mainApi: 'textgenerationwebui', maxContext: 8192, amountGen: 512 }), 7680);
    assert.equal(promptBudget({ mainApi: 'openai', chatCompletionSettings: {} }), null);
    assert.equal(promptBudget(null), null);
});

test('classifies budget pressure and only explains warnings', () => {
    const ctx = { mainApi: 'openai', chatCompletionSettings: { openai_max_context: 1000, openai_max_tokens: 0 } };
    assert.equal(checkPromptBudget(ctx, ['a'.repeat(320)]).level, 'ok');
    assert.equal(checkPromptBudget(ctx, ['a'.repeat(1600)]).level, 'warn');
    assert.equal(checkPromptBudget(ctx, ['a'.repeat(3200)]).level, 'over');
    assert.equal(checkPromptBudget({}, ['text']).level, 'unknown');
    assert.equal(budgetMessage(checkPromptBudget(ctx, ['a'.repeat(320)])), '');
    assert.match(budgetMessage(checkPromptBudget(ctx, ['a'.repeat(1600)])), /57%.*可能裁掉/);
    assert.match(budgetMessage(checkPromptBudget(ctx, ['a'.repeat(3200)])), /已超出上限/);
});
