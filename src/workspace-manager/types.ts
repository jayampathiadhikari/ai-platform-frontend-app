export interface JiraStory {
    id: string;
    projectId: string;
    tenantId: string;
    repoUrl: string;
    baseBranch: string;
    taskMd: string;
    claudeMd: string;
    description: string;
    retryCount: number;
    checkpointRef?: string; // S3 key of prior checkpoint, if resuming
}

export interface Workspace {
    jobId: string;
    jobDir: string;
    branch: string;
    repo: string;
    remoteUrl: string; // stored so teardown can push without rebuilding the token URL
}