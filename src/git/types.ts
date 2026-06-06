export interface GitResult {
    stdout: string;
    stderr: string;
}

export interface GitCloneOptions {
    /** Target directory to clone into. Defaults to a folder named after the repo. */
    targetDir?: string;
    /** Clone a specific branch straight away. */
    branch?: string;
    /** Limit clone depth (shallow clone). */
    depth?: number;
    /** Only fetch the specified branch — keeps the clone lean (`--single-branch`). */
    singleBranch?: boolean;
}

export interface GitCheckoutOptions {
    /** If true, creates the branch before checking it out (`git checkout -b`). */
    create?: boolean;
    /** When creating a branch, base it off this ref instead of HEAD. */
    startPoint?: string;
}