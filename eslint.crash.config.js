// The rules whose violation is a crash, not an opinion.
//
// The main config reports upwards of 140 problems -- unused variables, hook
// dependency advice, components declared inside components -- so nobody runs it,
// and the one finding that actually breaks a page is invisible among them. That is
// how `epmLoading is not defined` shipped: eslint had been reporting it, alone in
// its category, the whole time.
//
// This config carries only rules that mean the page throws in the browser. It comes
// out empty today, it runs in a couple of seconds, and `npm run build` is gated on
// it -- including on Vercel, whose build command is `npm run build`. Adding a rule
// here is a promise that it stays at zero; style rules belong in eslint.config.js.
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    // The source carries `eslint-disable-next-line react-hooks/exhaustive-deps`
    // comments. The plugin is registered so those names resolve -- none of its
    // rules are switched on here -- and unused directives are not reported, since
    // every one of them is unused as far as this config is concerned.
    plugins: { 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: false },
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Reading an identifier that does not exist is a ReferenceError. JSX builds
      // its children eagerly, so one of these in a branch that renders takes the
      // whole page down, not just the element it sits in.
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-class-assign': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      // Calling something that is not callable: `Math()`, `JSON()`.
      'no-obj-calls': 'error',
      // A duplicated key or member silently drops the first one.
      'no-dupe-keys': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      // Deliberately NOT here: no-use-before-define. A component that reads a
      // palette declared at the bottom of its module is flagged by it and is
      // perfectly fine at runtime, the function running long after the module
      // finished loading. Two dozen of those would put this config straight back
      // into the noise it exists to escape.
    },
  },
])
