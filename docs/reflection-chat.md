# Reflection chat backend

Reflection Chat saves private conversations and uses recent messages from the active chat for reflection. Conversations remain until the user deletes the chat or account. Both messages in each completed turn are saved together. Phase 2 adds optional journal context for each conversation.

## Frontend contract

Use the authenticated API client with cookies, `Content-Type: application/json`, and the existing CSRF header on writes. Send `{}` when creating or deleting a chat. Every response is marked `Cache-Control: no-store`.

| Method and path | Result |
| --- | --- |
| `POST /api/reflection-chats` | `201` with metadata. The chat starts at revision `0` and takes its title from the first completed user message. |
| `GET /api/reflection-chats?cursor=…` | Up to 20 summaries, most recently updated first. Pass `next_cursor` unchanged to continue. |
| `GET /api/reflection-chats/{chat_id}?before_revision=…` | Metadata and up to 30 completed turns, oldest first in each page. Pass `next_before_revision` unchanged to fetch older turns. |
| `PATCH /api/reflection-chats/{chat_id}` | Update journal access with `use_journals` and `expected_journal_access_version`. Returns the new chat metadata. A concurrent change returns `409`. |
| `POST /api/reflection-chats/{chat_id}/turns` | `200` with the completed turn. Use a new UUID for each new message and the current chat revision. `locale` supports `en` and `vi`. |
| `DELETE /api/reflection-chats/{chat_id}` | `204`. The chat and its messages are permanently deleted from the live database. |
| `GET /api/reflection-chats/support?country=VN&locale=vi` | Approved guidance and links for urgent and professional support. Country selection is explicit and the request contains no chat text. |

Render `reply` as plain text. The five outcomes are `reflection`, `mood_boundary`, `out_of_scope`, `professional_support`, and `urgent_support`. When `support_kind` is present, show the saved reply immediately and then load that section of the support response if the user selects a country. Keep the saved guidance visible if lookup fails. A resource link is opened only by the user.

Retry a network error with the original `turn_id` and message. A completed turn is replayed without another provider call, with its currently valid citations. On `409`, refresh the conversation and keep the draft. A stale consent change also requires the current `journal_access_version` before trying again. Honor `Retry-After` on `429`. Show the safe server error for `502` or `503` and retain the draft for retry. A `404` covers a missing chat and any chat that belongs to another account. The [JSON fixtures](fixtures/reflection-chat.json) include the successful response shapes, safety outcomes, and errors for development mocks.

## Journal access and citations

New and existing chats default to `use_journals: false`. The frontend should explain that opting in lets AuraJournal search that account’s saved journals and send selected excerpts to Groq. Access is checked per chat. Journal retrieval runs only on reflection turns after safety classification. Journal matches are ranked by distinct search terms, then by newest journal date. A message can request an exact `YYYY-MM-DD` date or an inclusive range such as `2024-02-27 to 2024-02-29` or `2024-02-27 đến 2024-02-29`. When there are no matches, the reply uses conversation context.

Turns include a `sources` array with `entry_id` and `journal_date` for each validated citation. Link each source to `/journal/{entry_id}`. Phase 1 turns have an empty array. If an entry changes or is deleted, its citation disappears from the saved turn and the reply remains readable.

Turning journal access off keeps old messages visible and excludes journal-grounded turns from future AI prompts. An in-flight reply based on the previous setting is discarded. Provider calls already sent cannot be recalled.

## Staging and verification

Apply Alembic revision `0012` and rerun `scripts/database-runtime-role.sql` after upgrading a restricted PostgreSQL deployment. The routes are enabled in development and tests. On staging, set `REFLECTION_CHAT_ENABLED=true` in the API environment only after a team owner validates the support guidance and directory links and checks the configured model with fictional journals. Provider-backed turns require the existing `GROQ_API_KEY`. A normal reflection uses separate classification, generation, and reply review calls. Direct urgent disclosures covered by the local rules use a fixed response and can succeed when the provider is unavailable. The bundled urgent directory points to [the Vietnam listings from Find A Helpline](https://findahelpline.com/countries/vn). Other countries and professional support use general guidance until a suitable local listing is reviewed.

Run `python -m pytest tests/test_reflection_chat.py tests/test_reflection_chat_journals.py tests/test_account_data.py tests/test_database.py -q` from `src/backend` with the disposable PostgreSQL `TEST_DATABASE_URL`. Tests use fake provider transports. Before enabling staging, review routing, excerpts, and citations with fictional English, Vietnamese, and mixed-language conversations. Check present danger, past disclosures, mood-label requests, an older high-relevance match, and an opt-out during generation.

## Phase 1 frontend

The protected `/reflection-chat` workspace includes desktop history, mobile
history drawer, new/resumed conversations, older-message pagination, composer,
plain-text replies, explicit country support lookup, and confirmed deletion.
Weekly recap remains at `/reflection`. English UI offers an English/Vietnamese
reply selector (initially based on browser language).

Unchanged retries retain their turn ID; editing a failed message creates a new
submission. Conflicts reload metadata/history and require explicit resend.
Cooldowns honor `Retry-After`. Switching chats cancels local requests; a server
turn already running may still save, so history reloads when returning. Drafts
and pending IDs stay in memory and clear on account changes or workspace exit.

Frontend checks: `npm run test:frontend`, `npm run build`, and
`BROWSER_BIN=/usr/bin/brave-browser npm run test:frontend:browser`. Browser checks
use fictional mocked API data. Live staging and support-owner sign-off remain
required before enabling the feature for testers.
