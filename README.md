# Augur

A prototype and research repository for product teams. Real, clickable
prototypes on one site, with login, comments and live boards on top.
Underneath it is all git and static HTML.

**See it running: [demo.augur.works](https://demo.augur.works)**, sign in with
`visita@fulla.demo` / `regadora`. It resets every night, so scribble away.

![The projects gallery](docs/shots/gallery.png)

The demo runs [Fulla](https://github.com/andratwiro/augur-space-fulla), an
invented community garden product. That repo doubles as the starter space, so
everything below works against it.

## Boards where the prototypes run

Drop a live prototype next to the stickies and drive it. Everyone on the board
sees the same screen state. Agents join as pixel mascots and work next to you.

![The research board, with live prototype tiles and two agents](docs/shots/board.png)

Up close: the specimen spins inside its tile, a teammate's cursor works the
area, and Menta the agent strolls over to watch.

![A live prototype spinning on the board while people and agents move](docs/shots/canvas-live.gif)

## Comments on the real pixels

Shift+C on any prototype opens review mode. A pin sticks to the element it
talks about, the thread keeps everyone's face on it, and the design system
shows through as a layer.

![Review mode on a prototype](docs/shots/review.png)

## Build your design library

The same space that holds your prototypes holds your design system. Tokens,
base, components, patterns and pages each get a tier, every entry is a plain
HTML page you write, and the site renders it with a live preview and the class
names it documents. A small registry gives the review overlay the same
vocabulary, so a pin on a prototype knows which component it landed on.

![The components tier of the library](docs/shots/library.png)

## Try it locally

```bash
git clone https://github.com/andratwiro/augur.git
git clone https://github.com/andratwiro/augur-space-fulla.git
cd augur-space-fulla
node ../augur/scripts/dev.mjs
```

That is the full shell on your machine, with about a second of hot reload. The
engine has no runtime dependencies, plain `node` is enough. Prototypes are
self-contained static HTML and also open straight from disk.

## How it is put together

- **A space is a git repo.** Your design system and your prototypes, nothing
  else. Only the contents of `prototypes/` folders and the gallery tiers ever
  publish. The research notes sitting next to them stay private by
  construction.
- **The engine is this repo.** It composes spaces into one static site and
  runs the overlay worker on Cloudflare. It carries no secrets and no content.
- **A private deploy shell holds your instance.** The engine pin, the user
  list, every secret. Engine fixes reach your instance by pin bump, never by
  forking.
- **Publishing is `augur publish`.** Seconds, atomic, straight from your
  clone. A git push saves and shares work without deploying anything.

## Run your own

[INSTALL.md](./INSTALL.md) is the whole recipe, written to be executed top to
bottom by a person or an agent. About an hour, most of it waiting on DNS
and CI.

## Docs

- [CLAUDE.md](./CLAUDE.md), the engine conventions
- [agents/](./agents/), the contracts for agents working in a space
- [CANVAS.md](./CANVAS.md), the board engine and how agents co-work on it
- [CONTRIBUTING.md](./CONTRIBUTING.md), fork to PR, never fork to deploy

## License

MIT. See [LICENSE](./LICENSE).
