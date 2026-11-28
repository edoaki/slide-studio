# Third-party notices

Slide Studio source code and desktop builds are distributed under the PolyForm Noncommercial License 1.0.0. See LICENSE for the full terms.

The desktop application includes Pandoc 3.9 as a separate executable. Pandoc is Copyright John MacFarlane and contributors, licensed under GPL-2.0-or-later. Its license is included with the executable in resources/pandoc/COPYING.md. Exact corresponding upstream source: https://github.com/jgm/pandoc/tree/3.9 ; source archive: https://github.com/jgm/pandoc/archive/refs/tags/3.9.tar.gz . Pandoc is invoked as a separate process.

Electron and Chromium notices are included in the packaged application's license resources. Third-party JavaScript dependencies retain their own license files in node_modules within app.asar.

The native AI runtime downloader uses node-tar 7.5.23 (ISC license) to extract verified release archives. Its license and dependency licenses are included with the packaged JavaScript modules. AI executables are downloaded from their respective official publishers into user data; they are not relicensed as Slide Studio code.

The macOS builds use ad-hoc signing. The Windows installer is unsigned. Users install updates manually.
