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
        }

        for (const entry of res.data) {
            if (entry.type !== "DIR") continue;
            if (isCancelled()) return;
            await visit(joinChildPath(path, entry.name));
        }
    }

    await visit(rootPath);
}
