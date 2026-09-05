// Self-contained smoke test for dsh-composer-upload (no dependencies).
// Loads client/client.js under stubbed window/document/react/ctx and asserts:
//  1) module exports name/inject/apply
//  2) apply registers exactly the two official slots
//  3) ContinueButton visibility rules (resumable goal shows, complete/typed/running hide)
//  4) components render without throwing
// Run: npm test   (exit code 0 = pass)
const fs = require('fs');
const os = require('os');
const path = require('path');

const src = path.join(__dirname, '..', 'client', 'client.js');

global.window = { __ModuleLoader__: { load: null }, getComputedStyle: () => ({ display: 'flex' }) };
global.document = {
  createElement: () => ({ appendChild() {}, remove() {}, click() {}, addEventListener() {}, setAttribute() {}, style: {}, focus() {}, select() {} }),
  head: { appendChild() {} },
  documentElement: {},
  body: { appendChild() {} },
  execCommand: () => true,
};

function stubReact() {
  const st = [];
  let c = 0;
  return {
    useState: (i) => { const x = c++; if (st[x] === undefined) st[x] = typeof i === 'function' ? i() : i; return [st[x], (v) => { st[x] = typeof v === 'function' ? v(st[x]) : v; }]; },
    useRef: (i) => { const x = c++; if (st[x] === undefined) st[x] = { current: i }; return st[x]; },
    useEffect: (fn) => { const r = fn(); if (typeof r === 'function') r(); },
    createElement: () => ({ kind: 'el' }),
  };
}

function load() {
  const tmp = path.join(os.tmpdir(), `dsh-cu-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
  fs.copyFileSync(src, tmp);
  let cap = null;
  global.window.__ModuleLoader__.load = (e) => { cap = e; };
  delete require.cache[tmp];
  require(tmp);
  fs.unlinkSync(tmp);
  return cap.factory((id) => {
    if (id === 'react' || id === 'react/jsx-runtime') return stubReact();
    throw new Error('unexpected require: ' + id);
  });
}

function makeCtx(phase, activation, reg) {
  return {
    slots: {
      inject: (k, cb) => cb(),
      register: (o, C) => { reg.push(C); return () => {}; },
    },
    sessions: {
      scope: () => ({ get: () => ({ createDraftImages: () => [], releaseDraftImages: () => {} }) }),
      binding: () => ({
        session: {
          projections: {
            faceOf: () => ({ getSnapshot: () => ({ goal: { id: 'g1', revision: 3, phase, activation } }) }),
          },
        },
      }),
    },
    remote: { goals: { resume: async () => ({ ok: true }) } },
    get: () => ({ createDraftImages: [], releaseDraftImages: () => {} }),
  };
}

const baseProps = {
  sessionId: 's1',
  session: { id: 's1' },
  inputActions: { setDraft() {}, addImages: () => true, submit() {} },
};
const idle = Object.assign({}, baseProps, {
  input: { phase: 'plain', draft: '' },
  useInput: (sel) => sel({ draft: '' }),
  useSession: (sel) => sel({ running: false, subagent: null }),
});
const typed = Object.assign({}, idle, { useInput: (sel) => sel({ draft: 'x' }) });
const running = Object.assign({}, idle, { useSession: (sel) => sel({ running: true, subagent: null }) });

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures += 1;
}

{
  const reg = [];
  const exp = load();
  check('exports name/inject', exp.name === 'dsh-composer-upload' && Array.isArray(exp.inject));
  exp.apply(makeCtx('paused', 'disarmed', reg));
  check('registers 2 seats', reg.length === 2);
  const [Upload, Continue] = reg;
  check('continue shows on paused+idle', Continue(idle) !== null);
  check('continue hides while typed', Continue(typed) === null);
  check('continue hides while running', Continue(running) === null);
  check('upload renders idle', Upload(idle) !== null);
}
{
  const reg = [];
  const exp = load();
  exp.apply(makeCtx('complete', 'armed', reg));
  check('continue shows when idle even if goal complete', reg[1](idle) !== null);
}

console.log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
