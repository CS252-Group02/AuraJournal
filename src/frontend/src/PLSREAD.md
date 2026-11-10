# AuraJournal frontend — read before changing code

This is the shared working guide for teammates and AI assistants. Read it before
editing the frontend. The [frontend README](../README.md) contains the detailed
architecture, file movement table, setup instructions, and PR1 verification.

The structure below describes PR1, based on `main` at `64833bc`. Always inspect
the current branch and affected files before working: future changes may make
this snapshot outdated. Update both guides when an intentional architecture
change lands. Follow applicable `AGENTS.md` instructions and the current task;
flag conflicts instead of silently expanding the task or guessing a new design.

## 1. What PR1 changed

PR1 organized existing code without changing the product:

| Before, relative to `src/frontend/src/` | After |
| --- | --- |
| `App.jsx` | `pages/JournalPage.jsx` |
| `Record.jsx` | `pages/RecordPage.jsx` |
| `Login.jsx` | `pages/LoginPage.jsx` |
| `Register.jsx` | `pages/RegisterPage.jsx` |
| `Auth.jsx` | `auth/Auth.jsx` |
| `AuthLayout.jsx` | `auth/AuthLayout.jsx` |
| `api.js` | `lib/api.js` |
| `style.css` | `styles/global.css` + `styles/journal.css` |
| `login.css` | `styles/login.css` |
| `record.css` | `styles/record.css` |

Other changes: corrected imports, the API test loader path, Record font URLs,
and existing documentation references; formatted the route table; added the
frontend README and this guide. `styles/index.css` makes stylesheet loading
order explicit. `main.jsx`, assets, and font licenses stay in their existing
locations.

All existing React components, local helpers, hooks, states, handlers, routes,
guards, API contracts, auth behavior, and rendered UI were retained. No backend,
dependency, framework, or feature changes were part of PR1. Default component
functions still have their original names (`App`, `Record`, `Login`, `Register`);
`main.jsx` imports them as `JournalPage`, `RecordPage`, `LoginPage`, and
`RegisterPage`. These are aliases for the same components, not wrappers.

**Scope distinction:** PR1's ban on new components/features applied to the
structural refactor. Future feature PRs may add real components, hooks, screens,
or behavior when required by their task. The ongoing rules below govern their
placement and maintenance; they do not freeze development.

## 2. Current structure and responsibilities

```text
src/frontend/
├── README.md                 # Detailed contributor guide
├── index.html                # HTML entry and external auth font link
├── vite.config.js
└── src/
    ├── PLSREAD.md             # This teammate/AI guide
    ├── main.jsx              # Mounting, providers, router, guards
    ├── pages/
    │   ├── JournalPage.jsx    # Journal loading/create/edit/delete UI and state
    │   ├── RecordPage.jsx     # Existing static Ready screen
    │   ├── LoginPage.jsx      # Login form and validation
    │   └── RegisterPage.jsx   # Registration form and validation
    ├── auth/
    │   ├── Auth.jsx           # Session state, auth actions, hooks, route guards
    │   └── AuthLayout.jsx     # Shared auth shell, theme, fields, helpers
    ├── lib/
    │   └── api.js             # Cookie/CSRF requests, errors, session isolation
    ├── styles/
    │   ├── index.css          # Ordered CSS entry imported once by main.jsx
    │   ├── global.css         # Shared document/element defaults and utilities
    │   ├── journal.css        # Existing journal form/list/dialog rules
    │   ├── login.css          # Both login and registration; themes and motion
    │   └── record.css         # Record styles, responsive rules, local fonts
    └── assets/               # Existing Record fonts and license
```

Current stack: React 19, React Router 7, Vite 6, JavaScript/JSX, plain CSS.
Dependencies, lockfile, scripts, and frontend API tests live at repository root.
Do not add a second frontend package or migrate the stack as incidental cleanup.

## 3. Where future code belongs

Create directories only when they contain real, needed code. `components/` and
`features/` are future conventions, not directories created by PR1.

| Responsibility | Placement | Examples for future work |
| --- | --- | --- |
| Route screen and page coordination | `pages/` | `HistoryPage.jsx`, `ReflectionPage.jsx` |
| Domain-independent UI primitive | `components/ui/` | `Button`, `Modal`, `Panel`, `Input` |
| Shared application layout/navigation | `components/layout/` | `AppShell`, `Sidebar`, `Header` |
| Domain-specific UI and behavior | `features/<feature>/` | Journal, record, calendar, reflection |
| Shared request/infrastructure utilities | `lib/` | Existing `api.js` |
| Session state and authentication UI | `auth/` | Existing provider, guards, auth layout |

Feature examples: `features/journal/components/JournalCard.jsx`,
`features/record/components/TranscriptPanel.jsx`, and
`features/calendar/components/JournalCalendar.jsx`. Add feature `hooks/`,
`services/`, or utility files only when they have an actual responsibility.

- Multiple consumers do not make a domain component generic. A journal card
  still belongs to the journal feature when several pages use it.
- Generic UI must not fetch journal data or know backend contracts, account
  state, recording, or calendar business rules.
- Small helpers used by one file may stay local. PR1 intentionally leaves
  `RecordButton`, `TranscriptPanel`, and `JournalMascot` in `RecordPage.jsx`.
- Auth helpers stay in `AuthLayout.jsx`: `ThemeSwitch`, `Field`, `SwitchLink`,
  `GoogleButton`, `Divider`, `useDark`, and `useShake`. Inspect before extracting
  or replacing them; `useAuth` stays with the provider in `Auth.jsx`.
- Reuse existing code where its responsibility fits. Extract cohesive behavior
  when complexity or actual reuse warrants it; do not create empty layers or
  one-line forwarding wrappers just to make the tree look scalable.
- As features grow, keep routes concerned with composition and coordination.
  Move substantive domain work into its feature in a scoped change. PR1's
  existing page-local journal logic is a baseline, not a reason to put every
  future subsystem into one page or into `main.jsx`.

## 4. Dependency and naming rules

```text
pages -> features -> components/ui
pages -> components/layout -> components/ui
pages / features / auth -> lib
```

Shared UI must not import pages, features, or authentication modules. `lib/`
must not depend on rendering or route components. Avoid circular imports and
direct cross-feature coupling; coordinate features at the page level instead.
Use explicit relative imports; PR1 introduces no aliases or barrel modules.

Use PascalCase for component files, `Page.jsx` for route screen filenames,
camelCase for utility modules, and `use` plus PascalCase for custom hook names.
New page component names should match their filenames. Existing legacy default
names listed above are intentional; renaming them is not required cleanup.

## 5. Routing and authentication protections

| Existing route | Component imported in `main.jsx` | Guard |
| --- | --- | --- |
| `/` | `JournalPage` | `PrivatePage` |
| `/login` | `LoginPage` | `GuestPage` |
| `/register` | `RegisterPage` | `GuestPage` |
| `/record` | `RecordPage` | `PrivatePage` |

Preserve `React.StrictMode`, `BrowserRouter`, and the single `AuthProvider` around
the route tree. Register an authorized new route in `main.jsx`, choosing access
rules deliberately. Do not rename existing routes or remove guards incidentally.

Keep the initial `/api/auth/me` loading/error behavior, anonymous/private
redirects, authenticated/guest redirects, login/register validation, logout
retry state, and unauthorized handling. Use `useAuth` and existing auth actions
rather than introducing a competing account store. Never store session tokens
in localStorage or expose another account's journal during a session switch.
Backend authorization remains necessary regardless of frontend guards.

## 6. API rules

Use `lib/api.js` for application API requests. Preserve its API base URL handling
(`VITE_API_URL`, default `http://localhost:8000`), `credentials: 'include'`, JSON
serialization, `X-AuraJournal-CSRF: 1`, error formatting/status, and unauthorized
event rules. Preserve epoch checks both before and after JSON parsing so late
responses cannot cross account boundaries. Do not duplicate this client inside
a page or feature.

Keep methods, endpoints, payloads, and existing error handling unless the task
intentionally changes the contract. Inspect the current backend and tests before
adding integrations. Never assume that an existing frontend request proves an
endpoint is implemented. Keep feature-specific services in their feature, using
the shared client; generic UI must not own API orchestration.

## 7. CSS and asset rules

The existing stylesheet order is intentional:

```text
main.jsx -> styles/index.css
             login.css -> record.css -> global.css -> journal.css
```

Do not reorder these imports, reintroduce scattered page CSS imports, or narrow
legacy selectors as unrelated cleanup. Existing global element defaults affect
multiple screens; they were preserved to maintain computed styles. Put new
page styles under a page class/prefix, and add their stylesheet to the central
entry in a deliberate position. Inspect all consumers before changing a shared
rule; sharing a CSS filename does not prevent selectors from leaking globally.

Preserve layout, typography, colors, responsive behavior, focus/hover/disabled
states, themes, animations, and reduced-motion behavior unless a design change
is explicitly part of the task. Keep font/asset URLs relative to the importing
file: `record.css` uses `../assets/...`. Retain asset licenses. Avoid global
resets, specificity escalation, or a new styling system as incidental fixes.

## 8. Work sequence for teammates and AI assistants

1. Read the current task, applicable repo instructions, this guide, and the
   frontend README. Inspect `git status`, actual files/imports, root
   `package.json`, and relevant tests. Preserve unrelated in-progress changes.
2. Trace the affected routes, component dependencies, auth/API flow, CSS, and
   assets. Search for existing implementations before adding another one.
3. State the intended change and placement. Separate requested behavior from
   cleanup, existing limitations, and future ideas. Clarify only material
   requirements that inspection cannot resolve.
4. Implement the smallest coherent change. Keep business logic, presentation,
   and infrastructure in their appropriate locations. Avoid unrelated renames,
   formatting churn, frameworks, dependencies, stores, or speculative abstractions.
5. Preserve loading, empty, error, pending, validation, cancellation, and disabled
   states. When changing asynchronous code, verify account isolation and stale
   responses. Do not turn placeholders into working features without that scope.
6. Run the required checks and appropriate targeted regression tests. Review the
   complete diff, including new files, imports, asset paths, and shared CSS.
7. Update both frontend guides when structure or conventions change. Explain
   deliberate exceptions with their reason; do not leave docs describing an old
   architecture after moving the code.
8. Report what changed, intentional behavior changes, checks actually run, skipped
   checks, limitations, and follow-up work. Do not commit or open a PR unless asked.

## 9. Validation and review checklist

Run from the repository root:

```sh
npm run build
npm run test:frontend
git diff --check
```

Use `npm run dev` for frontend-only development or `npm start` after backend
setup to run both services. See the [frontend README](../README.md) for setup.

- Confirm imports/assets resolve and dependency direction stays clear.
- Cover changed behavior with meaningful targeted tests. Existing frontend tests
  cover the API client and session races, not all React UI behavior.
- For routing/UI/CSS changes, check relevant routes and shared consumers in a
  browser when available. Verify login/register/logout, guards, journal
  loading/create/edit/cancel/delete confirmation, Record placeholders, themes,
  responsive layout, fonts, focus, and disabled states as applicable.
- For a pure refactor, compare the same data/viewports before and after. For a
  feature, verify the intended new behavior and regression of existing behavior.
- Report mocked API checks separately from live cookie/backend checks. Never
  claim browser verification when only a build or unit tests ran.
- Review naming, duplicated logic, component placement, global style effects,
  accidental contract changes, and unrelated file changes before finishing.

PR1's historical verification passed build/API tests and a temporary headless
browser comparison: 100 assertions, 30 matching DOM/style/geometry/screenshots,
and identical sequences of 60 API requests per build. Production JavaScript was
byte-identical to the baseline. API responses were mocked; external Google fonts
were blocked consistently and local Record fonts loaded. These are PR1 results,
not proof that a future change passes, nor a requirement that feature bundles
remain byte-identical. No browser framework was added to the repository.

## 10. Known limitations at PR1 — separate future work

- Journal edit/delete UI sends PATCH and DELETE requests, but the baseline
  backend has only create/list entry handlers and allows GET/POST through CORS.
  Those writes may fail at preflight or as unsupported requests. Preserve error
  handling; do not add backend support during unrelated frontend cleanup.
- Record is a static Ready screen. Record/sidebar controls are disabled;
  “Back to Main” is a span, not working navigation. No speech-to-text is wired.
- `GoogleButton` and `Divider` remain defined but are not rendered by the auth
  forms. Google authentication is not implemented.
- Legacy global CSS inheritance remains. Broader scoping needs a deliberate
  visual regression review, not an opportunistic rewrite.

Recheck these facts against current code before reporting or implementing them;
a later feature PR may resolve a limitation. Update the guides when it does.

## 11. Copy this into an AI task

This file does not automatically configure every AI tool. Explicitly ask the
assistant to read it; do not assume it has loaded these rules.

```text
Before changing AuraJournal, read applicable AGENTS.md instructions,
src/frontend/src/PLSREAD.md, src/frontend/README.md, the root package.json,
and the current files/tests relevant to this task.

Task: [describe the requested behavior and acceptance criteria here]

Inspect the current branch before assuming the docs still match it. Reuse the
existing frontend architecture and explain where new code belongs. Preserve
unrelated behavior, auth/session protections, API contracts, and CSS consumers.
Do not introduce dependencies, architecture layers, or features outside the task.
Keep the diff focused and update the guides if architecture changes. Run build,
frontend tests, and relevant regression checks; report what actually ran, what
was mocked/skipped, and any pre-existing limitations. Do not commit or open a PR
unless explicitly requested.
```
