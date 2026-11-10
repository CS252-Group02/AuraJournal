# AuraJournal frontend

The frontend uses React 19, React Router 7, Vite 6, JavaScript/JSX, and plain
CSS. Dependencies and npm scripts live in the repository-root `package.json`.
Run the commands below from the repository root, not from this directory.

Start with [PLSREAD.md](src/PLSREAD.md) for teammate and AI working rules and a
reusable task prompt. Keep both guides current when the architecture changes.

## Current architecture

```text
src/frontend/
├── README.md
├── index.html
├── vite.config.js
└── src/
    ├── PLSREAD.md             # Teammate and AI working rules
    ├── main.jsx
    ├── pages/
    │   ├── JournalPage.jsx
    │   ├── RecordPage.jsx
    │   ├── LoginPage.jsx
    │   └── RegisterPage.jsx
    ├── auth/
    │   ├── Auth.jsx
    │   └── AuthLayout.jsx
    ├── lib/
    │   └── api.js
    ├── styles/
    │   ├── index.css
    │   ├── global.css
    │   ├── journal.css
    │   ├── login.css
    │   └── record.css
    └── assets/
        ├── record-fonts-LICENSE.txt
        ├── record-cormorant-garamond-latin-600.woff2
        └── record-inter-latin.woff2
```

| Location | Responsibility and current examples |
| --- | --- |
| `main.jsx` | Mount React with `StrictMode`, `BrowserRouter`, `AuthProvider`, and the route table. |
| `pages/` | Route-level screens and their existing page state, API orchestration, and interactions. `JournalPage.jsx` owns the journal form, list, editing state, and confirmation dialog. |
| `auth/Auth.jsx` | `AuthProvider`, `useAuth`, `PrivatePage`, and `GuestPage`; initial session check, authentication, logout, and unauthorized events. |
| `auth/AuthLayout.jsx` | Shared login/register shell and theme selection; existing `ThemeSwitch`, `Field`, `SwitchLink`, `GoogleButton`, `Divider`, `useDark`, and `useShake` remain here. |
| `lib/` | Shared infrastructure. `api.js` handles request configuration, errors, and session-epoch protection. |
| `styles/` | The ordered stylesheet entry, shared defaults, and existing page styles. |
| `assets/` | Bundled fonts and their license. Keep asset references relative to the importing source file. |

### Routes and authentication

| Route | Screen | Guard |
| --- | --- | --- |
| `/` | `JournalPage.jsx` | `PrivatePage` |
| `/login` | `LoginPage.jsx` | `GuestPage` |
| `/register` | `RegisterPage.jsx` | `GuestPage` |
| `/record` | `RecordPage.jsx` | `PrivatePage` |

Private routes redirect anonymous visitors to `/login`; guest routes redirect
authenticated visitors to `/`. The provider waits for `/api/auth/me` before
rendering its children and owns the existing connection/logout error screens.
Keep one provider around the route tree.

Use `useAuth` for account state and authentication actions, and the shared `api`
function for backend requests. It reads `VITE_API_URL` (default
`http://localhost:8000`), includes cookies, sends JSON and
`X-AuraJournal-CSRF: 1`, and discards responses from a previous authentication
epoch. Preserve those protections when changing request code. Session tokens
are managed by the backend's HttpOnly cookie; the existing localStorage key
`aurajournal-theme` stores only the theme preference.

See [authentication](../../docs/authentication.md) for cookie, origin, CSRF, and
session details. Frontend redirects do not replace backend authorization.

## Component placement and naming

Keep route-level components in `pages/`, with PascalCase names ending in
`Page.jsx`. Use PascalCase for other component filenames, camelCase for utility
modules such as `api.js`, and `use` followed by PascalCase for hook names such as
`useAuth`. Use relative imports; there are no path aliases or barrel modules.

PR1 keeps the existing default component declarations (`App`, `Record`, `Login`,
and `Register`) intact. `main.jsx` imports those same components under names
matching their page filenames. No additional wrapper components are involved.

Small components used only within one file may stay local. For example,
`RecordButton`, `TranscriptPanel`, and `JournalMascot` remain in `RecordPage.jsx`.
Shared authentication helpers such as `Field` remain in `auth/AuthLayout.jsx`;
sharing a helper between login and registration does not make it a generic UI
primitive. Reuse an existing component before introducing another one, and
extract only when an actual responsibility or reuse need warrants it.

### Future organization (directories do not exist yet)

Create these locations only when future work has a real implementation to put
in them. PR1 adds no shared UI primitives, layouts, feature modules, or hooks.

| Future location | Placement rule and AuraJournal examples |
| --- | --- |
| `components/ui/` | Domain-independent primitives such as `Button`, `Modal`, `Panel`, or `Input`. They must not know about journals, recording, authentication, or API contracts. |
| `components/layout/` | Shared application layout/navigation such as `AppShell`, `Sidebar`, or `Header`. |
| `features/<feature>/` | Domain-specific components, hooks, services, and utilities. Examples: `features/journal/components/JournalCard.jsx`, `features/record/components/TranscriptPanel.jsx`, and `features/calendar/components/JournalCalendar.jsx`. A reflection feature would follow the same pattern. |

A journal or recording component belongs to its feature even if several pages
use it. Do not move feature components into `components/ui/` merely because
they have multiple consumers.

Preferred dependency direction for future development:

```text
pages -> features -> components/ui
pages -> components/layout -> components/ui
pages / features / auth -> lib
```

Shared UI must not import pages, feature modules, or authentication logic.
Infrastructure in `lib/` must not depend on page rendering. Avoid circular
imports and direct cross-feature coupling; compose features at the page level.
The existing small page-local implementations do not need speculative layers
to satisfy these future conventions.

## CSS and assets

`main.jsx` imports `styles/index.css` once. It imports styles in this order:
`login.css`, `record.css`, `global.css`, then `journal.css`. This explicit entry
preserves the previous eager-loading cascade without relying on page module
imports to load styles as side effects.

- `global.css` contains document defaults, element styles, the shared `.page`
  layout, and the existing accessibility utility.
- `journal.css` contains the journal form, entry list/actions, and confirmation
  dialog styles.
- `login.css` serves both login and registration, including their light/dark
  tokens, theme switch, validation, animations, and reduced-motion rules.
- `record.css` owns the Record layout, responsive rules, and local font faces.
  Its font URLs use `../assets/...`; preserve the accompanying font license.
- `index.html` retains the external Be Vietnam Pro font link used by auth pages.

The legacy element defaults and some auth helper selectors are intentionally
retained with their original specificity. Other screens currently inherit them.
Do not scope, reorder, or delete them as incidental cleanup: that requires a
separate visual regression review. Keep new page rules under a page class,
using existing prefixes such as `.record-` or `.login-` where appropriate, and
add their stylesheet to `index.css` in an intentional position. Check all routes
when changing shared rules. Preserve focus, hover, disabled, theme, motion, and
responsive states as well as the default appearance.

## Adding pages and components in future PRs

1. Put an authorized new route screen in `pages/` and keep its coordination
   there. Reuse existing auth and UI helpers where their responsibilities fit.
2. Add the route in `main.jsx` under the existing provider. Choose `PrivatePage`
   or `GuestPage` according to access requirements; retain existing route paths.
3. Place supporting components using the rules above. Keep a one-file helper
   local; create a future shared/feature directory only when it contains real
   code. Do not add empty directories, placeholder components, or a new provider
   merely to illustrate architecture.
4. Use `lib/api.js` for requests, retain session protection, and keep
   feature-specific request helpers out of generic UI modules.
5. Add page CSS to the ordered stylesheet entry, update this guide if the
   structure changes, and run the checks below before review.

## Development and verification

Use Node.js 20+ and install the root dependencies with `npm ci`. Follow the
[root setup guide](../../README.md#setup) for Python, PostgreSQL, migrations,
and local environment files. On first setup, copy `.env.example` in this
directory to `.env.local` if API configuration is needed. Use `localhost`
consistently for frontend and API.

Run from the repository root:

```sh
npm run dev             # Frontend only, normally http://localhost:5173
npm start               # Frontend and backend; requires backend setup
npm run build           # Production build in src/frontend/dist/
npm run test:frontend   # Existing API/session regression tests
```

The [frontend tests](../../tests/frontend-api.test.js) verify cookies/CSRF,
request payloads, stale-response rejection before and after JSON parsing, and
unauthorized-event behavior. Their loader reads `src/lib/api.js` relative to
this directory. There is no committed browser automation framework. Unit tests
and a build do not verify rendering or a live cookie session.

For browser regression checks, compare the same data and viewport before and
after a change. Exercise all four routes, anonymous/authenticated redirects,
login/register validation, logout and retry errors, journal loading/create,
edit/cancel, delete confirmation/cancel, Record's Ready screen and disabled
controls, theme persistence, and local font loading. Check desktop/mobile
widths and the existing CSS breakpoints (360, 640, 768, and 1024px), plus focus,
hover, and reduced motion. When using mocked API responses, record that fact
and report live backend verification separately.

## PR1 baseline and structural changes

Baseline: `main` at `64833bc` (verified against GitHub). The original source
directory was flat: page screens, auth modules, the API client, and CSS were
siblings of `main.jsx`. `App.jsx` was the journal screen rather than an app
shell; `style.css` mixed shared defaults with journal rules. Existing components
and responsibilities are listed above and remain intact.

| Original source path | Current source path |
| --- | --- |
| `App.jsx` | `pages/JournalPage.jsx` |
| `Record.jsx` | `pages/RecordPage.jsx` |
| `Login.jsx` | `pages/LoginPage.jsx` |
| `Register.jsx` | `pages/RegisterPage.jsx` |
| `Auth.jsx` | `auth/Auth.jsx` |
| `AuthLayout.jsx` | `auth/AuthLayout.jsx` |
| `api.js` | `lib/api.js` |
| `style.css` | `styles/global.css` and `styles/journal.css` |
| `login.css` | `styles/login.css` |
| `record.css` | `styles/record.css` |

`main.jsx` and `assets/` stay in place. Import paths, the API test loader, font
URLs, and documentation references follow the moves. The route table is
formatted for readability; components, hooks, business logic, dependencies,
backend code, and route/HTTP contracts are unchanged.

### PR1 verification results

- `npm run build` and `npm run test:frontend` pass from the repository root.
- All eight JavaScript modules match the baseline syntax trees after normalizing
  import paths, page import aliases, and insignificant JSX whitespace. The
  production JavaScript bundle is byte-for-byte identical to the baseline.
- Every original CSS rule is retained; font asset paths resolve and font/license
  contents are unchanged. Local module imports resolve without dependency cycles.
- Headless Brave checks pass for both builds: 100 assertions, 30 matching
  DOM/computed-style/geometry/screenshot comparisons at widths from 320 to 1440px,
  and identical sequences of 60 API requests per build. Scenarios include the
  four routes, auth flows and errors, journal interactions, Record placeholders,
  themes, and responsive layouts.

The browser run used mocked API responses, including HTTP 405 for unsupported
PATCH/DELETE requests. It did not verify live backend cookies or the backend's
CORS preflight behavior. External Google fonts were blocked equally for both
builds; Record's local fonts loaded. The temporary comparison harness added no
dependencies or browser test framework to the repository.

## Pre-existing limitations and separate follow-up work

- Journal edit/delete UI sends `PATCH /api/entries/{id}` with `{content}` and
  `DELETE /api/entries/{id}` with no body. The baseline backend only implements
  create/list entry routes, and its CORS configuration allows GET/POST. These
  writes remain unsupported; cross-origin requests can fail at preflight before
  reaching a route. Preserve the UI and its existing error handling in PR1.
- `RecordPage.jsx` is a static Ready screen. Recording/sidebar controls remain
  disabled, and “Back to Main” remains a non-interactive span. Speech-to-text,
  navigation, and AI integration require separate feature work.
- `GoogleButton` and `Divider` remain defined in `AuthLayout.jsx` but are not
  rendered by login/register. Google sign-in is not implemented.
- Legacy global CSS/default inheritance remains a consideration for future
  screens. Broader scoping or a design system needs its own visual review.
