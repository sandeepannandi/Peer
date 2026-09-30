# Dependency security refresh

Checked 30 September 2026 against npm's current advisory database. The locked
tree had 12 affected package entries (four production transitives, eight dev
entries). This is not a count of unique vulnerabilities or confirmed exploits.
The refreshed locked tree returns zero advisory entries for both full and
production-only audits at this check. Future advisories can change that result.

Vitest moves from 2.1.9 to 4.1.11 because the mocker path-traversal fix requires
4.1.11. Vite is explicitly constrained to the patched 6.4 branch: it satisfies
Vitest's supported range and preserves the project's Node 20 baseline, unlike
newer Vite majors that require newer Node point releases. ESLint stays on major
9, execa on major 9, and the Claude SDK lock stays at 0.3.227. Only the audit
fixes and the test-runner dependency graph change; no SDK/auth policy upgrade.

Production transitives refreshed: hono 4.13.12, fast-uri 3.1.8, ip-address
10.7.2 and qs 6.16.0. Dev fixes include ESLint/plugin-kit, brace-expansion,
Vitest/mocker, Vite and its esbuild. Full gates, native SQLite, deterministic
review fixtures and compiled CLI smoke are checked on Linux/Windows Node
20/22. CI also fails on high/critical npm advisories; no exception is added.

The affected dev-server/UI paths are not used by `vitest run`; dependency
presence alone does not show a production exploit. Production transitive
reachability depends on the SDK paths actually used; this refresh does not
claim a runtime exploit was reproduced or a full third-party security audit.

Sources:

- https://github.com/advisories/GHSA-82fw-gwwq-j7x9
- https://github.com/advisories/GHSA-5xrq-8626-4rwp
- https://github.com/advisories/GHSA-fx2h-pf6j-xcff
- https://github.com/advisories/GHSA-67mh-4wv8-2f99
- https://github.com/advisories/GHSA-xffm-g5w8-qvg7
- https://github.com/advisories/GHSA-q2hr-2g5m-vwhr
- https://github.com/advisories/GHSA-hrr3-gc8f-f4qj
- https://github.com/advisories/GHSA-g6gw-c38x-mqfc
- https://github.com/advisories/GHSA-j6r3-76f7-8jcv
- https://github.com/advisories/GHSA-4mjr-xmp4-gh2g
