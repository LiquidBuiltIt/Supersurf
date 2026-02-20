"use strict";
/**
 * Secure Eval — AST-based analysis for browser_evaluate code.
 * Blocks dangerous patterns (network calls, storage access, code injection,
 * obfuscation) before code reaches the extension.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeCode = analyzeCode;
exports.wrapWithPageProxy = wrapWithPageProxy;
const acorn = __importStar(require("acorn"));
const walk = __importStar(require("acorn-walk"));
// ── Helpers ──────────────────────────────────────────────────
function isIdentifier(node, name) {
    return node?.type === 'Identifier' && node.name === name;
}
function isMemberCall(callee, obj, prop) {
    return (callee?.type === 'MemberExpression' &&
        isIdentifier(callee.object, obj) &&
        isIdentifier(callee.property, prop) &&
        !callee.computed);
}
// ── Blocked patterns ─────────────────────────────────────────
const BLOCKED_PATTERNS = [
    // Blocked API calls (direct: fetch(), or via global: window.fetch())
    {
        nodeType: 'CallExpression',
        matcher: (node) => {
            const callee = node.callee;
            const BLOCKED_APIS = ['fetch', 'eval', 'atob', 'btoa', 'Function'];
            const GLOBALS = ['window', 'globalThis', 'self', 'top', 'frames', 'parent'];
            if (callee?.type === 'Identifier') {
                return BLOCKED_APIS.includes(callee.name);
            }
            if (callee?.type === 'MemberExpression' &&
                callee.object?.type === 'Identifier' &&
                GLOBALS.includes(callee.object.name) &&
                !callee.computed &&
                callee.property?.type === 'Identifier' &&
                BLOCKED_APIS.includes(callee.property.name)) {
                return true;
            }
            return false;
        },
        reason: 'Direct call to blocked API',
    },
    // Comma operator bypass: (0, fetch)('/api')
    {
        nodeType: 'CallExpression',
        matcher: (node) => {
            const callee = node.callee;
            if (callee?.type === 'SequenceExpression' && callee.expressions?.length > 0) {
                const last = callee.expressions[callee.expressions.length - 1];
                const BLOCKED_APIS = ['fetch', 'eval', 'atob', 'btoa', 'Function'];
                if (last?.type === 'Identifier' && BLOCKED_APIS.includes(last.name)) {
                    return true;
                }
            }
            return false;
        },
        reason: 'Comma operator bypass to blocked API',
    },
    // this-as-global: this.fetch(), this.eval()
    {
        nodeType: 'CallExpression',
        matcher: (node) => {
            const callee = node.callee;
            const BLOCKED_APIS = ['fetch', 'eval', 'atob', 'btoa', 'Function'];
            if (callee?.type === 'MemberExpression' &&
                callee.object?.type === 'ThisExpression' &&
                callee.property?.type === 'Identifier' &&
                BLOCKED_APIS.includes(callee.property.name)) {
                return true;
            }
            return false;
        },
        reason: 'Blocked API call via this',
    },
    // Object.getOwnPropertyDescriptor(s) — descriptor extraction bypass
    {
        nodeType: 'CallExpression',
        matcher: (node) => isMemberCall(node.callee, 'Object', 'getOwnPropertyDescriptor') ||
            isMemberCall(node.callee, 'Object', 'getOwnPropertyDescriptors'),
        reason: 'Property descriptor extraction (Object.getOwnPropertyDescriptor/s)',
    },
    // Iframe/script creation — contentWindow escape hatch / inline code execution
    {
        nodeType: 'CallExpression',
        matcher: (node) => {
            if (!isMemberCall(node.callee, 'document', 'createElement'))
                return false;
            const arg = node.arguments?.[0];
            if (arg?.type === 'Literal' && typeof arg.value === 'string') {
                return ['iframe', 'script'].includes(arg.value.toLowerCase());
            }
            return false;
        },
        reason: 'Blocked element creation (iframe/script — unproxied global access or inline code execution)',
    },
    // Obfuscation primitives
    {
        nodeType: 'CallExpression',
        matcher: (node) => isMemberCall(node.callee, 'String', 'fromCharCode') ||
            isMemberCall(node.callee, 'String', 'raw'),
        reason: 'String obfuscation primitive (String.fromCharCode / String.raw)',
    },
    // Timer string execution
    {
        nodeType: 'CallExpression',
        matcher: (node) => {
            const callee = node.callee;
            if (callee?.type === 'Identifier' &&
                ['setTimeout', 'setInterval'].includes(callee.name)) {
                const firstArg = node.arguments?.[0];
                return (firstArg?.type === 'Literal' && typeof firstArg.value === 'string') ||
                    firstArg?.type === 'TemplateLiteral';
            }
            return false;
        },
        reason: 'setTimeout/setInterval with string argument (implicit eval)',
    },
    // Reflection
    {
        nodeType: 'CallExpression',
        matcher: (node) => isMemberCall(node.callee, 'Reflect', 'get') ||
            isMemberCall(node.callee, 'Reflect', 'apply'),
        reason: 'Reflection API (Reflect.get / Reflect.apply)',
    },
    // Network beacon
    {
        nodeType: 'CallExpression',
        matcher: (node) => isMemberCall(node.callee, 'navigator', 'sendBeacon'),
        reason: 'Network exfiltration via navigator.sendBeacon',
    },
    // Navigation hijack — location.assign() / location.replace()
    {
        nodeType: 'CallExpression',
        matcher: (node) => isMemberCall(node.callee, 'location', 'assign') ||
            isMemberCall(node.callee, 'location', 'replace'),
        reason: 'Navigation hijack (location.assign / location.replace)',
    },
    // Storage access
    {
        nodeType: 'MemberExpression',
        matcher: (node, ancestors) => {
            if (node.object?.type === 'Identifier' &&
                ['localStorage', 'sessionStorage'].includes(node.object.name)) {
                return true;
            }
            return false;
        },
        reason: 'Direct storage access (use the browser_storage tool instead)',
    },
    // Cookie access (dot and bracket notation)
    {
        nodeType: 'MemberExpression',
        matcher: (node) => {
            if (!isIdentifier(node.object, 'document'))
                return false;
            if (!node.computed && isIdentifier(node.property, 'cookie'))
                return true;
            if (node.computed && node.property?.type === 'Literal' && node.property.value === 'cookie')
                return true;
            return false;
        },
        reason: 'Direct cookie access (use dedicated MCP tools instead)',
    },
    // Dynamic global access
    {
        nodeType: 'MemberExpression',
        matcher: (node) => {
            if (node.computed &&
                node.object?.type === 'Identifier' &&
                ['window', 'globalThis', 'self', 'top', 'frames', 'parent'].includes(node.object.name)) {
                return true;
            }
            return false;
        },
        reason: 'Computed property access on global object (potential obfuscation)',
    },
    // document.defaultView — window alias
    {
        nodeType: 'MemberExpression',
        matcher: (node) => isIdentifier(node.object, 'document') &&
            isIdentifier(node.property, 'defaultView') &&
            !node.computed,
        reason: 'Window alias via document.defaultView',
    },
    // Block API references on global objects (catches aliasing: const f = window.fetch)
    {
        nodeType: 'MemberExpression',
        matcher: (node, ancestors) => {
            const BLOCKED_APIS = ['fetch', 'eval', 'atob', 'btoa', 'Function'];
            const GLOBALS = ['window', 'globalThis', 'self', 'top', 'frames', 'parent'];
            if (node.object?.type === 'Identifier' &&
                GLOBALS.includes(node.object.name) &&
                !node.computed &&
                node.property?.type === 'Identifier' &&
                BLOCKED_APIS.includes(node.property.name)) {
                // Skip if this is the callee of a CallExpression — let the call rule handle it
                const parent = ancestors[ancestors.length - 2];
                if (parent?.type === 'CallExpression' && parent.callee === node)
                    return false;
                return true;
            }
            return false;
        },
        reason: 'Blocked API reference on global object',
    },
    // Prototype walking
    {
        nodeType: 'MemberExpression',
        matcher: (node) => {
            if (node.property?.type === 'Identifier') {
                return ['__proto__', 'constructor'].includes(node.property.name);
            }
            if (node.property?.type === 'Literal' &&
                typeof node.property.value === 'string') {
                return ['__proto__', 'constructor'].includes(node.property.value);
            }
            return false;
        },
        reason: 'Prototype chain walking (__proto__ / constructor)',
    },
    // Dangerous constructors
    {
        nodeType: 'NewExpression',
        matcher: (node) => {
            if (node.callee?.type === 'Identifier') {
                return [
                    'Function', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'Image',
                    'Worker', 'SharedWorker', 'RTCPeerConnection',
                ].includes(node.callee.name);
            }
            return false;
        },
        reason: 'Dangerous constructor (network/code execution escape)',
    },
    // Import expressions
    {
        nodeType: 'ImportExpression',
        matcher: () => true,
        reason: 'Dynamic import() expression',
    },
    // Tagged template obfuscation (e.g. String.raw`...`)
    {
        nodeType: 'TaggedTemplateExpression',
        matcher: (node) => isMemberCall(node.tag, 'String', 'raw'),
        reason: 'String obfuscation primitive (String.fromCharCode / String.raw)',
    },
    // javascript: protocol in string literals — XSS vector
    {
        nodeType: 'Literal',
        matcher: (node) => typeof node.value === 'string' &&
            node.value.trimStart().toLowerCase().startsWith('javascript:'),
        reason: 'javascript: protocol string literal (XSS vector)',
    },
];
// ── Analyzer ─────────────────────────────────────────────────
function analyzeCode(code) {
    if (!code || !code.trim()) {
        return { safe: true };
    }
    let ast;
    try {
        ast = acorn.parse(code, {
            ecmaVersion: 'latest',
            sourceType: 'module',
            allowReturnOutsideFunction: true,
            allowAwaitOutsideFunction: true,
        });
    }
    catch {
        // Syntax errors → let Runtime.evaluate return its own error
        return { safe: true };
    }
    let violation = null;
    walk.ancestor(ast, {
        CallExpression(node, _state, ancestors) {
            if (violation)
                return;
            for (const pattern of BLOCKED_PATTERNS) {
                if (pattern.nodeType === 'CallExpression' && pattern.matcher(node, ancestors)) {
                    violation = { safe: false, reason: pattern.reason };
                    return;
                }
            }
        },
        MemberExpression(node, _state, ancestors) {
            if (violation)
                return;
            for (const pattern of BLOCKED_PATTERNS) {
                if (pattern.nodeType === 'MemberExpression' && pattern.matcher(node, ancestors)) {
                    violation = { safe: false, reason: pattern.reason };
                    return;
                }
            }
        },
        NewExpression(node, _state, ancestors) {
            if (violation)
                return;
            for (const pattern of BLOCKED_PATTERNS) {
                if (pattern.nodeType === 'NewExpression' && pattern.matcher(node, ancestors)) {
                    violation = { safe: false, reason: pattern.reason };
                    return;
                }
            }
        },
        ImportExpression(node, _state, ancestors) {
            if (violation)
                return;
            for (const pattern of BLOCKED_PATTERNS) {
                if (pattern.nodeType === 'ImportExpression' && pattern.matcher(node, ancestors)) {
                    violation = { safe: false, reason: pattern.reason };
                    return;
                }
            }
        },
        TaggedTemplateExpression(node, _state, ancestors) {
            if (violation)
                return;
            for (const pattern of BLOCKED_PATTERNS) {
                if (pattern.nodeType === 'TaggedTemplateExpression' && pattern.matcher(node, ancestors)) {
                    violation = { safe: false, reason: pattern.reason };
                    return;
                }
            }
        },
        Literal(node, _state, ancestors) {
            if (violation)
                return;
            for (const pattern of BLOCKED_PATTERNS) {
                if (pattern.nodeType === 'Literal' && pattern.matcher(node, ancestors)) {
                    violation = { safe: false, reason: pattern.reason };
                    return;
                }
            }
        },
    });
    return violation ?? { safe: true };
}
// ── Page-context Proxy wrapper (Layer 3) ────────────────────
const PAGE_BLOCKED = [
    'fetch', 'eval', 'atob', 'btoa', 'Function',
    'WebSocket', 'XMLHttpRequest', 'EventSource', 'Image',
    'Worker', 'SharedWorker', 'RTCPeerConnection',
    'importScripts', 'open',
    'localStorage', 'sessionStorage',
];
// Properties blocked on sub-objects (document.cookie, navigator.sendBeacon, etc.)
const SUB_OBJECT_RULES = {
    document: { blocked: ['cookie', 'write', 'writeln'], aliases: { defaultView: '__proxy' } },
    navigator: { blocked: ['sendBeacon'], aliases: {} },
    location: { blocked: ['assign', 'replace'], aliases: {} },
};
/**
 * Wrap user code in a page-context Proxy that intercepts blocked API access.
 * Sloppy-mode outer for `with`, strict-mode inner for the user code.
 * Returns a self-contained IIFE string ready for Runtime.evaluate.
 */
function wrapWithPageProxy(code) {
    const blockedJSON = JSON.stringify(PAGE_BLOCKED);
    const subRulesJSON = JSON.stringify(SUB_OBJECT_RULES);
    return `(function() {
  var __blocked = new Set(${blockedJSON});
  var __globalAliases = new Set(['window', 'globalThis', 'self', 'top', 'frames', 'parent']);
  var __subRules = ${subRulesJSON};
  function __wrapSub(obj, name) {
    var rules = __subRules[name];
    if (!rules) return obj;
    var blockedSet = new Set(rules.blocked);
    var aliases = rules.aliases;
    return new Proxy(obj, {
      get: function(t, p) {
        if (typeof p === 'string' && blockedSet.has(p)) {
          throw new Error('[secure_eval] Blocked: ' + name + '.' + p);
        }
        if (typeof p === 'string' && aliases[p] === '__proxy') {
          return __proxy;
        }
        var v = Reflect.get(t, p);
        if (typeof v === 'function') return v.bind(t);
        return v;
      }
    });
  }
  var __proxy = new Proxy(window, {
    get: function(t, p) {
      if (typeof p === 'string' && __blocked.has(p)) {
        throw new Error('[secure_eval] Blocked: ' + p);
      }
      if (typeof p === 'string' && __globalAliases.has(p)) {
        return __proxy;
      }
      var v = Reflect.get(t, p);
      if (v === window) return __proxy;
      if (typeof p === 'string' && __subRules[p] && typeof v === 'object' && v !== null) {
        return __wrapSub(v, p);
      }
      return v;
    },
    has: function() { return true; },
    getOwnPropertyDescriptor: function(t, p) {
      if (typeof p === 'string' && __blocked.has(p)) {
        return { configurable: true, enumerable: false, get: function() {
          throw new Error('[secure_eval] Blocked: ' + p);
        }};
      }
      if (typeof p === 'string' && __globalAliases.has(p)) {
        return { configurable: true, enumerable: true, value: __proxy };
      }
      return Object.getOwnPropertyDescriptor(t, p);
    },
    ownKeys: function(t) {
      return Reflect.ownKeys(t);
    }
  });
  with(__proxy) {
    return (function() { "use strict";
return (
${code}
);
    })();
  }
})()`;
}
//# sourceMappingURL=secure-eval.js.map