# Trademarks, brand assets and bundled fonts

[LICENSE](./LICENSE) is MIT and covers the **code**. It does not, and was never meant to,
hand over the project's name or the files in [`brand/`](./brand). This page says where that
line is, because a bare MIT file placed next to a logo reads as though it grants the logo
too.

## What the MIT licence does not grant

**The name.** "Augur", used as the name of a product, a service, a company or a domain.

**The marks.** `brand/augur-mark.svg`, `brand/augur-icon.svg`, `brand/augur-eye.svg`, and
the copies of them that a build emits (`augur-mark.png`, `augur-icon-192.png`,
`augur-icon-512.png`, `augur-eye.svg`). Copying a file is not a licence to wear it.

**The fonts.** `brand/lentianova.woff2`, `brand/lentianova-bulky.otf` and
`brand/lentianova-median.otf` are **third-party typefaces, licensed to this project and not
sublicensable by it**. They sit in the repository because the build needs them; they are
not covered by the MIT grant, and no MIT grant could cover them, because they are not this
project's to give. If you are shipping something built from this repository, obtain your
own licence or substitute your own typeface — every font reference resolves through the
design-system tokens, so replacing it is a value change, not a code change.

> The project's own licence position on these typefaces is not yet settled for commercial
> use. Until it is, treat them as the most restricted files in the repository.

`src/canvas/DSEG7Classic-Bold.woff2` is different: it ships under the SIL Open Font
License, and its terms are in [`src/canvas/DSEG-LICENSE.txt`](./src/canvas/DSEG-LICENSE.txt)
alongside it.

## What you can do without asking

**Run it, fork it, change it, ship it.** That is what MIT is for, and none of the above
narrows it. A fork that keeps the code and replaces the name and the marks needs no
permission from anyone.

**Say what it is.** "Built on Augur", "compatible with Augur", "an Augur instance" —
describing a thing accurately by its name is nominative use, and it is fine. So is naming
the project in a talk, a blog post, an academic paper or a comparison table.

**Keep the marks in an unmodified copy.** Redistributing the repository as it is, marks
included, is fine. What is not fine is lifting the marks out of it.

## What needs asking

Using the name or the marks in a way that suggests a project is **the** Augur, or is
endorsed by, affiliated with or maintained by it. Concretely: naming your product or your
company Augur or something confusable with it; registering a domain of the form
`augur-<something>` for a service you run; putting the mark on a paid hosted service; or
using it as the icon of an application that is not this one.

Modified copies must not carry the marks. That is the whole point of the carve-out: the
mark is how someone tells which copy they are looking at, and a mark on a fork makes that
question unanswerable.

## Asking

Open an issue on the repository. There is no form and no fee.

---

*This page describes the position; it is not legal advice, and it has not yet been through
a lawyer. The trademark itself is not yet cleared — see the project's own launch notes. If
you are relying on any of this commercially, ask your own counsel.*
