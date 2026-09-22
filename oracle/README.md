# oracle/ — the criteria page's source

The page `<prototype>/oracle/index.html` loads from `/__oracle/`. See
[agents/criteria.md](../agents/criteria.md) for what it is.

```
cd oracle && npm install && npm run build     # writes ../src/oracle/oracle.{js,css}
```

The built files are committed: `build.js` copies them to `dist/__oracle/`, so a deploy
needs no toolchain beyond Node. Rebuild and commit both whenever `src/` changes.
