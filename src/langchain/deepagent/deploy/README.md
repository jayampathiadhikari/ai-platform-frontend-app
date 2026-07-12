# DeepDevAgent — Deployment Guide

## Directory Structure

```
deploy/
├── agent/
│   └── Dockerfile            ← Agent container (multi-stage TS build)
├── executor/
│   ├── Dockerfile            ← Executor sidecar (minimal, no credentials)
│   ├── server.ts             ← Sidecar HTTP server source
│   ├── package.json
│   └── tsconfig.json
├── fargate/
│   ├── task-definition.json  ← ECS Fargate task definition (2 containers)
│   └── iam-policies.yml      ← IAM roles, security group, NACL rules
├── docker-compose.yml        ← Local dev (mirrors Fargate sidecar pattern)
└── README.md                 ← This file
```

---

## Local Development

Runs both containers with shared volume — exact same architecture as Fargate.

### Prerequisites

- Docker Desktop running
- `.env` file at the repo root with `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` set

### Start

```bash
# From the repo root
cd src/langchain/deepagent/deploy

docker compose up --build    # first run (builds images)
docker compose up            # subsequent runs
```

### Test

```bash
# Trigger a deepagent job
curl -X POST http://localhost:3000/run/deepagent \
     -H "Content-Type: application/json" \
     -d '{"jiraId": "PROJ-1"}'

# Check status
curl http://localhost:3000/jobs

# Check executor health directly
curl http://localhost:2080/health   # ← not exposed in compose (localhost only)
```

### Stop

```bash
docker compose down        # stop containers, keep volumes
docker compose down -v     # stop and wipe the jobs volume
```

---

## How the Sidecar Works

```
Agent Container                    Executor Sidecar
(has API keys, IAM role)           (no credentials)
         │                                  │
         │  POST http://executor:8080/exec  │
         │  { command: "npm test",          │
         │    cwd: "/workspace/jobs/..." }  │
         │ ──────────────────────────────► │
         │                                  │  execAsync(command, { cwd })
         │  { stdout, stderr, exitCode }    │  ← runs in isolated container
         │ ◄────────────────────────────── │
```

**Key difference from Fargate:** In local Docker Compose, the two containers talk over the `agent-net` bridge network using the hostname `executor`. In ECS Fargate, they share the same network namespace and communicate over `127.0.0.1:8080`. The `EXECUTOR_URL` environment variable controls this:

| Environment | `EXECUTOR_URL` value |
|---|---|
| Local Docker Compose | `http://executor:8080` |
| ECS Fargate | `http://127.0.0.1:8080` |

---

## Fargate Deployment

### 1. Build and push images to ECR

```bash
# Authenticate
aws ecr get-login-password --region REGION \
  | docker login --username AWS \
    --password-stdin ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com

# Create repositories (first time only)
aws ecr create-repository --repository-name deepagent-agent
aws ecr create-repository --repository-name deepagent-executor

# Build and push agent
docker build -t deepagent-agent \
  -f src/langchain/deepagent/deploy/agent/Dockerfile .
docker tag  deepagent-agent:latest \
  ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/deepagent-agent:latest
docker push ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/deepagent-agent:latest

# Build and push executor
docker build -t deepagent-executor \
  -f src/langchain/deepagent/deploy/executor/Dockerfile .
docker tag  deepagent-executor:latest \
  ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/deepagent-executor:latest
docker push ACCOUNT_ID.dkr.ecr.REGION.amazonaws.com/deepagent-executor:latest
```

### 2. Create Secrets Manager entries

```bash
aws secretsmanager create-secret \
  --name deepagent/anthropic-api-key \
  --secret-string "sk-ant-..."

aws secretsmanager create-secret \
  --name deepagent/github-token \
  --secret-string "ghp_..."
```

### 3. Create IAM roles

See `fargate/iam-policies.yml` for the exact policy documents.

```bash
# Create execution role (ECS control plane pulls images, fetches secrets)
aws iam create-role \
  --role-name deepagent-execution-role \
  --assume-role-policy-document file://fargate/execution-trust-policy.json

aws iam attach-role-policy \
  --role-name deepagent-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# Create task role (agent container runtime permissions)
aws iam create-role \
  --role-name deepagent-task-role \
  --assume-role-policy-document file://fargate/task-trust-policy.json
```

### 4. Register task definition

```bash
# Replace ACCOUNT_ID and REGION in task-definition.json first
sed -i 's/ACCOUNT_ID/123456789012/g; s/REGION/us-east-1/g' \
  fargate/task-definition.json

aws ecs register-task-definition \
  --cli-input-json file://fargate/task-definition.json
```

### 5. Create CloudWatch log groups

```bash
aws logs create-log-group --log-group-name /ecs/deepagent/agent
aws logs create-log-group --log-group-name /ecs/deepagent/executor
```

### 6. Create ECS service

```bash
aws ecs create-service \
  --cluster your-cluster \
  --service-name deepagent \
  --task-definition deepagent-task \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
    subnets=[subnet-xxx],
    securityGroups=[sg-xxx],
    assignPublicIp=DISABLED
  }"
```

---

## Security Notes

- The `executor` container has **no AWS credentials** — the `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` env var is intentionally absent from its container definition
- AWS Secrets (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`) are injected **only into the agent container** via ECS Secrets Manager integration
- Block the ECS IMDS endpoint (`169.254.170.2`) at the VPC Network ACL level — see `fargate/iam-policies.yml` for the NACL rule
- The executor image contains only: `git`, `node`, `npm`, `python3`, `bash`, `curl` — no AWS CLI
