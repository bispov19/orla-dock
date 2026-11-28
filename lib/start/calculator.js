// Orla Dock
// Copyright (c) 2026 Vinícius de Souza Bispo
// Licensed under the MIT License - see LICENSE file
// SPDX-License-Identifier: MIT
//
// start/calculator.js — a calculadora da busca do Menu Iniciar.
//
// Digitar "2+3*4" na busca mostra "14". A conta é feita em dois passos:
//   1. o texto vira uma lista de "fichas" (números, operadores, parênteses);
//   2. o algoritmo do "pátio de manobras" (shunting-yard, de Dijkstra)
//      reorganiza as fichas em notação pós-fixada (3 4 * 2 +), respeitando
//      a precedência; daí o cálculo é só uma pilha.
// Nada de eval(): só números e operadores conhecidos são aceitos.
//
// Aceita + − × ÷ ^ %, parênteses, vírgula ou ponto decimal, sinal negativo
// e as constantes pi e e.

const OPERATORS = {
    '+': {precedence: 1, right: false, apply: (a, b) => a + b},
    '-': {precedence: 1, right: false, apply: (a, b) => a - b},
    '*': {precedence: 2, right: false, apply: (a, b) => a * b},
    '/': {precedence: 2, right: false, apply: (a, b) => a / b},
    '%': {precedence: 2, right: false, apply: (a, b) => a % b},
    '^': {precedence: 4, right: true, apply: (a, b) => a ** b},
    'neg': {precedence: 3, right: true, unary: true, apply: a => -a},
};
const CONSTANTS = {pi: Math.PI, e: Math.E};

function tokens(text) {
    const source = text.replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/')
        .replace(/−/g, '-').toLowerCase();
    const out = [];
    let i = 0;
    while (i < source.length) {
        const rest = source.slice(i);
        const number = /^(\d+([.,]\d+)?|[.,]\d+)/.exec(rest);
        if (number) {
            out.push({type: 'number', value: parseFloat(number[0].replace(',', '.'))});
            i += number[0].length;
            continue;
        }
        const constant = /^(pi|e)(?![a-z])/.exec(rest);
        if (constant) {
            out.push({type: 'number', value: CONSTANTS[constant[1]]});
            i += constant[0].length;
            continue;
        }
        const char = source[i];
        if (char in OPERATORS) {
            // Um "-" no começo, depois de operador ou de "(" é sinal negativo.
            const previous = out[out.length - 1];
            const unary = char === '-' && (!previous || previous.type === 'op' || previous.value === '(');
            out.push({type: 'op', value: unary ? 'neg' : char});
        } else if (char === '(' || char === ')') {
            out.push({type: 'paren', value: char});
        } else {
            return null;
        }
        i++;
    }
    return out;
}

/** Fichas na ordem pós-fixada (ou null se os parênteses não fecham). */
function toPostfix(list) {
    const output = [];
    const stack = [];
    for (const token of list) {
        if (token.type === 'number') {
            output.push(token);
        } else if (token.type === 'op') {
            const op = OPERATORS[token.value];
            while (stack.length) {
                const top = stack[stack.length - 1];
                if (top.type !== 'op')
                    break;
                const topOp = OPERATORS[top.value];
                const higher = topOp.precedence > op.precedence ||
                    (topOp.precedence === op.precedence && !op.right);
                if (!higher || op.unary)
                    break;
                output.push(stack.pop());
            }
            stack.push(token);
        } else if (token.value === '(') {
            stack.push(token);
        } else {
            while (stack.length && stack[stack.length - 1].value !== '(')
                output.push(stack.pop());
            if (!stack.length)
                return null;
            stack.pop();
        }
    }
    while (stack.length) {
        const token = stack.pop();
        if (token.type === 'paren')
            return null;
        output.push(token);
    }
    return output;
}

/**
 * O resultado da conta, ou null se o texto não for uma conta (ou for só
 * um número, que não vale a pena "calcular").
 */
export function calculate(text) {
    if (!/[\d)]\s*[-+*/^%×÷−]|^\s*[-−(]|\b(pi|e)\b/i.test(text))
        return null;
    const list = tokens(text);
    if (!list || !list.some(t => t.type === 'op'))
        return null;
    const postfix = toPostfix(list);
    if (!postfix)
        return null;
    const stack = [];
    for (const token of postfix) {
        if (token.type === 'number') {
            stack.push(token.value);
            continue;
        }
        const op = OPERATORS[token.value];
        if (op.unary) {
            if (stack.length < 1)
                return null;
            stack.push(op.apply(stack.pop()));
        } else {
            if (stack.length < 2)
                return null;
            const b = stack.pop();
            const a = stack.pop();
            stack.push(op.apply(a, b));
        }
    }
    if (stack.length !== 1 || !Number.isFinite(stack[0]))
        return null;
    // Até 10 casas, sem zeros sobrando (0.1+0.2 → 0.3).
    return Number(stack[0].toPrecision(12));
}
