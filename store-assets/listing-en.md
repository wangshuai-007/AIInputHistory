# Chrome Web Store Listing (English)

## Name

AI Input History

## Short description

Save AI chat drafts and sent prompts locally, with search, filtering, and fast history recall.

## Detailed description

AI Input History helps recover prompts lost because of unsent drafts, page errors, or accidental actions. Input history stays in the current browser by default and is never uploaded to a developer-operated server. Data is sent externally only when you explicitly enable a completion notification service you configure.

Key features:

- Automatically save chat drafts and periodic snapshots;
- Consolidate incremental snapshots after sending and keep only the final sent entry;
- Browse previous prompts with the arrow keys, similar to Chrome DevTools Console;
- Filter by site, search full text, or show only sent entries;
- Built-in support for ChatGPT, Claude, Gemini, Grok, DeepSeek, Copilot, Perplexity, Kimi, Doubao, Qwen, GLM, and other popular AI sites;
- Add other AI domains manually;
- English and Chinese interfaces, dark mode, custom shortcuts, and a movable floating button; right-click an active timer to stop a stuck observation;
- Track total sends, today, this week, and this month separately for each AI; every actual send is counted, even within the same conversation, with an independent clear action;
- Queue prompts while ChatGPT is replying, with edit, withdraw, and Send now actions; right-click the floating button to disable or re-enable Queue, sending directly while disabled without deleting existing queued prompts;
- Track ChatGPT send-to-completion duration per conversation and optionally notify on completion; version 1.37.9 fixes retention and restoration of actively observed generations lasting over 30 minutes;
- Filter automatic completion notifications by minimum duration (20 seconds by default) and multiple local-time availability ranges, including overnight ranges, with a local redacted debug log for troubleshooting;
- Notifications support browser/system notifications, Bark, ServerChan, PushPlus, ntfy, Gotify, DingTalk, Feishu, WeCom robots, and custom HTTP requests;
- Independently enable local Pro usage trends; switching tracking on automatically reads the current account's recognizable plan category, with manual correction/retry for unverified tiers. Deduplicated page and network model signals are counted; the selected Pro model button shows a subtle parenthesized count INSIDE the native control (e.g. Pro (15) ▾, with shared ceilings still marked ≤), without an additional tooltip or extra click target, supports hidden measurement text in model buttons, alternate DOM nesting and text dropdown arrows, and exposes privacy-safe load diagnostics; never presented as an official quota balance;
- Clear unpinned history with confirmation while preserving pinned entries.

Privacy disclosure: The extension reads chat input text, page titles, and domains on supported or user-added sites to provide local history. History stays local by default. Only when you explicitly enable an external completion notification will the configured summary or template data be sent to the selected service. Data is not sent to the developer, sold, or used for advertising or analytics.

When Pro counting is enabled, model/mode fields and HTTP status are read from ChatGPT conversation requests. A temporary cache contains sanitized metadata only, not raw network request bodies or authentication information. Explicitly enabling Pro counting automatically reads the account plan once; the manual retry button remains available. These actions query same-origin account/member endpoints to classify the current account and the user’s own seat; raw account data, member lists, and temporary login tokens are not retained or exported.

## Suggested category

Productivity

## Support and privacy URLs

- Privacy policy: Publish `store-assets/privacy-policy.md` at a public HTTPS URL;
- Support URL: Use the project homepage or issue tracker.
