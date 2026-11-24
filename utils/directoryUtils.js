const SORT_OPTIONS = {
    name: "name",
    date: "updatedAt",
    size: "size",
    type: "extension",
};

const SORT_DIRECTIONS = {
    asc: 1,
    desc: -1,
};

export const CASE_INSENSITIVE_COLLATION = {
    locale: "en",
    strength: 2,
};

export function isValidDirectorySort(sortBy, sortDir) {
    return (
        (!sortBy || Object.hasOwn(SORT_OPTIONS, sortBy)) &&
        (!sortDir || Object.hasOwn(SORT_DIRECTIONS, sortDir))
    );
}

export function getDirectorySort(sortBy, sortDir, isDirectory) {
    const field = SORT_OPTIONS[sortBy];

    if (!field || (isDirectory && field === "extension")) {
        return { createdAt: -1, _id: -1 };
    }

    return {
        [field]: SORT_DIRECTIONS[sortDir] ?? 1,
        _id: -1,
    };
}