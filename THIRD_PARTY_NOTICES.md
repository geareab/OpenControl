# Third-Party Notices

OpenControl's host source is MIT licensed. Its direct runtime dependencies and
the runtime packages they install are:

| Package          |  Locked version | License    |
| ---------------- | --------------: | ---------- |
| `dualsense-ts`   |         6.15.38 | LGPL-3.0   |
| `node-addon-api` | 3.2.1 and 7.1.1 | MIT        |
| `node-hid`       |           3.3.0 | MIT or X11 |
| `node-pty`       |           1.1.0 | MIT        |
| `pkg-prebuilds`  |           1.1.0 | MIT        |
| `zod`            |           4.4.3 | MIT        |

`dualsense-ts` is authored by Nate Dube and contributors and is distributed
under the GNU Lesser General Public License version 3. OpenControl uses it as
an unmodified, separately installed library. Its source and the required LGPL
and GPL license texts are available in the installed package and at
<https://github.com/nsfm/dualsense-ts>.

The exact transitive inventory is recorded in `package-lock.json`. CI checks
declared licenses and generates a CycloneDX SBOM for every verified source
revision. Dependency packages retain their own copyright and license notices.

The optional firmware under `firmware/` is a separate GPL-2.0-or-later work. It
is included in the GitHub source repository, but is excluded from any future MIT
host package published to npm.
