# `data` - signals, their sources and pulls, circuit boards, presets - changelog

An adopted app has no update path: once `box adopt` copies it in, the code is the team's. This
file is how a later version reaches an existing Box - a team's agent reads it and applies the parts
that still make sense against the code they have customised. Newest first, one `## <version>`
section per release.

## 1.0.0

First published version. Extracted from the Silkweave Box maintainer source at `b7a2fe5`, where
this app lived as a distributed feature, and published unchanged apart from tightening its core
compatibility range to `^1.0.0` now that core carries an honest version.
