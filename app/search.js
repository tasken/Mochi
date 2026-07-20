export function matchesSearchQuery(name, query) {
    if (!query) return false;
    return name.toLowerCase().includes(query.toLowerCase());
}

export async function walkForSearchMatches(rootPath, query, deps) {
    const {
        readFolder,
        isCancelled,
        onMatch,
        onFolderScanned,
        onFolderError,
        joinChildPath,
        onBinFile,
    } = deps;

    async function visit(path) {
        if (isCancelled()) return;

        let res;
        let failure = null;
        try {
            res = await readFolder(path);
        } catch (err) {
            failure = err.message || String(err);
        }

        // Re-check after the await: a walk can be superseded while this
        // read was in flight. The response already arrived, but it's stale
        // — don't report matches or progress for it.
        if (isCancelled()) return;

        if (failure !== null) {
            onFolderError(path, failure);
            return;
        }
        if (!res.ok) {
            onFolderError(path, res.error);
            return;
        }

        onFolderScanned(path);

        for (const entry of res.data) {
            if (matchesSearchQuery(entry.name, query)) {
                onMatch({
                    name: entry.name,
                    type: entry.type,
                    size: entry.size,
                    parentPath: path,
                });
            }
            if (
                onBinFile &&
                entry.type === "FILE" &&
                entry.name.toLowerCase().endsWith(".bin")
            ) {
                onBinFile(entry, path);
            }
        }

        for (const entry of res.data) {
            if (entry.type !== "DIR") continue;
            if (isCancelled()) return;
            await visit(joinChildPath(path, entry.name));
        }
    }

    await visit(rootPath);
}

export async function enrichWithTagIdentity(files, query, deps) {
    const {
        readFileData,
        isCancelled,
        lookupIdentity,
        joinChildPath,
        onMatch,
        onFileChecked,
    } = deps;

    for (const file of files) {
        if (isCancelled()) return;

        let head = file.meta ? file.meta.nfcTagHead : null;
        let tail = file.meta ? file.meta.nfcTagTail : null;

        if (head == null || tail == null) {
            let res = null;
            try {
                res = await readFileData(
                    joinChildPath(file.parentPath, file.name),
                );
            } catch {
                res = null;
            }

            // Re-check after the await: this run can be superseded while the
            // read was in flight.
            if (isCancelled()) return;

            if (res && res.ok && res.data && res.data.length >= 92) {
                const dv = new DataView(res.data.buffer, res.data.byteOffset);
                // Big-endian: matches how the firmware writes the UID into
                // the file, same offsets/endianness populateFileDetails
                // already decodes (app.js).
                head = dv.getUint32(84, false);
                tail = dv.getUint32(88, false);
                file.meta = {
                    ...(file.meta || {}),
                    nfcTagHead: head,
                    nfcTagTail: tail,
                };
            } else {
                onFileChecked(file);
                continue;
            }
        }

        if (head >>> 0 === 0 && tail >>> 0 === 0) {
            // Same "not an NFC tag file" signal populateFileDetails already
            // treats as a neutral, non-error outcome.
            onFileChecked(file);
            continue;
        }

        const info = await lookupIdentity(head, tail);
        if (isCancelled()) return;
        onFileChecked(file);
        if (!info) continue;

        const candidates = [
            ["name", info.name],
            ["tagSeries", info.tagSeries],
            ["gameSeries", info.gameSeries],
        ];
        for (const [field, value] of candidates) {
            if (value && matchesSearchQuery(value, query)) {
                onMatch({
                    name: file.name,
                    type: "FILE",
                    size: file.size,
                    parentPath: file.parentPath,
                    matchedField: field,
                    matchedValue: value,
                });
                break;
            }
        }
    }
}
