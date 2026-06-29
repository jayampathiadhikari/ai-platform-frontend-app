/**
 * In-process job registry.
 *
 * Tracks every job started since the process booted. Each record holds an
 * AbortController so any caller can cancel the running agent mid-session.
 *
 * NOTE: This is an in-memory store — restarting the server clears it.
 * For production, replace with a DynamoDB/Redis-backed registry.
 */

export type JobStatus = "running" | "cancelled" | "done" | "failed";

export interface JobRecord {
    jobId: string;
    jiraId: string;
    status: JobStatus;
    startedAt: Date;
    finishedAt?: Date;
    /** Internal — used to signal the agent loop to stop. */
    readonly controller: AbortController;
}

const registry = new Map<string, JobRecord>();

/**
 * Register a new job. Returns the AbortController so the caller can pass
 * its signal down into the agent.
 */
export function registerJob(jobId: string, jiraId: string): AbortController {
    const controller = new AbortController();
    registry.set(jobId, {
        jobId,
        jiraId,
        status: "running",
        startedAt: new Date(),
        controller,
    });
    console.log(`[job-registry] Registered job ${jobId} (jiraId=${jiraId})`);
    return controller;
}

/**
 * Mark a job as cancelled and abort its controller.
 * Returns false if the job does not exist or is already finished.
 */
export function cancelJob(jobId: string): boolean {
    const job = registry.get(jobId);
    if (!job) return false;
    if (job.status !== "running") return false;

    job.status = "cancelled";
    job.finishedAt = new Date();
    job.controller.abort(new Error(`Job ${jobId} was cancelled by user`));
    console.log(`[job-registry] Cancelled job ${jobId}`);
    return true;
}

/**
 * Cancel every running job. Called during graceful shutdown so no agent
 * keeps consuming API credits after the server process exits.
 * Returns the number of jobs that were cancelled.
 */
export function cancelAllJobs(): number {
    let count = 0;
    for (const job of registry.values()) {
        if (job.status === "running") {
            job.status = "cancelled";
            job.finishedAt = new Date();
            job.controller.abort(new Error("Server shutting down"));
            count++;
        }
    }
    if (count > 0) {
        console.log(`[job-registry] Cancelled ${count} running job(s) due to shutdown`);
    }
    return count;
}

/**
 * Update a job's status when it finishes naturally.
 */
export function finishJob(jobId: string, status: Exclude<JobStatus, "running">): void {
    const job = registry.get(jobId);
    if (!job) return;
    job.status = status;
    job.finishedAt = new Date();
    console.log(`[job-registry] Job ${jobId} finished with status=${status}`);
}

/**
 * Look up a job record (omits the internal controller from the return value).
 */
export function getJob(jobId: string): Omit<JobRecord, "controller"> | undefined {
    const job = registry.get(jobId);
    if (!job) return undefined;
    const { controller: _omit, ...rest } = job;
    return rest;
}

/**
 * List all jobs in the registry (newest first).
 */
export function listJobs(): Omit<JobRecord, "controller">[] {
    return [...registry.values()]
        .map(({ controller: _omit, ...rest }) => rest)
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}
