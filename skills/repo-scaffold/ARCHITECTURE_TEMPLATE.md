# Architecture Document

> **Living Document** — This document is maintained by the `delivery:code-issue` agent during development. It is initially created by the `delivery:code-planner` agent and updated as the system evolves.

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [System Architecture](#system-architecture)
- [Project Structure](#project-structure)
- [Data Model](#data-model)
- [API Reference](#api-reference)
- [Authentication & Authorization](#authentication--authorization)
- [External Integrations](#external-integrations)
- [Deployment](#deployment)
- [Development Workflow](#development-workflow)
- [Decision Log](#decision-log)

---

## Overview

<!-- Brief description of the system, its purpose, and its users -->

**Project**: {project-name}
**Created**: {date}
**Status**: In Development

## Tech Stack

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| Frontend | | | |
| Backend | | | |
| Database | | | |
| Auth | | | |
| Testing | | | |
| CI/CD | | | |

<!-- Delete rows that do not apply. A CLI or library has no frontend row; a stateless
     service has no database row. An empty row invites someone to invent a fact. -->

## System Architecture

<!-- High-level architecture diagram. Replace the placeholder below with the real shape of
     this system — do not leave a generic three-tier diagram in place if that is not what
     was built. -->

```mermaid
graph TB
    subgraph Client
        A[Browser / App]
    end
    subgraph Server
        B[API Layer]
        C[Service Layer]
        D[Data Access]
    end
    subgraph Data
        E[(Database)]
    end
    A -->|HTTP/REST| B
    B --> C
    C --> D
    D --> E
```

## Project Structure

```
{project-name}/
├── src/
│   ├── ...
├── tests/
│   ├── ...
├── docs/
│   ├── ARCHITECTURE.md    ← You are here
│   └── USER_GUIDE.md
├── .github/
│   ├── workflows/
│   └── ISSUE_TEMPLATE/
└── {project manifest — package.json / pyproject.toml / go.mod / Cargo.toml / ...}
```

## Data Model

<!-- Entity-Relationship diagram -->

```mermaid
erDiagram
    %% Add entities as the data model evolves
```

<!-- If the project has no persistent data model, say so here in one line and delete the
     diagram rather than leaving an empty one. -->

## API Reference

<!-- Document API endpoints as they are created -->

### Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| | | | |

### Request/Response Examples

<!-- Add examples as endpoints are implemented -->

## Authentication & Authorization

<!-- Document auth strategy, roles, and permissions -->

### Strategy
<!-- OAuth2, OIDC, JWT, session cookies, mTLS, API keys, none — and where it is enforced -->

### Roles & Permissions

| Role | Permissions |
|------|------------|
| | |

<!-- If access is scoped to a tenant, project, or organisation, state the scoping key here
     and note that every query must filter on it. Scoping that is applied in some queries
     and forgotten in others is the failure mode: one tenant's record silently satisfies
     another tenant's check. -->

## External Integrations

<!-- Document third-party services and APIs -->

| Service | Purpose | Protocol | Status |
|---------|---------|----------|--------|
| | | | |

## Deployment

### Prerequisites
<!-- What's needed to deploy -->

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| | | | |

<!-- Names and purposes only. Never record a secret's value here. -->

### Build & Deploy

```bash
# Build
# Deploy
# Verify
```

### Infrastructure

```mermaid
graph LR
    %% Add infrastructure diagram as deployment is configured
```

## Development Workflow

### Getting Started

```bash
# Clone and setup
git clone <repo-url>
cd <project-name>
# Install dependencies
# Start development server
```

### Commands

| Command | Purpose |
|---------|---------|
| | |

<!-- These must match the commands in CLAUDE.md exactly, including any directory prefix or
     explicit interpreter path. Two documents disagreeing about how to run the tests is
     worse than one document. -->

### Branch Strategy

- `{default branch}` — Production-ready code
- `feature/issue-{N}-{desc}` — Feature branches per issue
- PRs require review before merge

### Data Handling Constraints

<!-- Optional. If any file, directory, or class of data must never be committed, read, or
     copied into a transcript, name it here alongside the reason. Record the enforcement
     mechanism too (ignore rules, a pre-commit check, a hook) — a rule that lives only in
     prose is a request, not a control. Delete this section if it does not apply. -->

## Decision Log

<!-- Record architectural decisions as they are made -->

| Date | Decision | Rationale | Alternatives Considered |
|------|----------|-----------|------------------------|
| {date} | {initial tech stack choice} | {why} | {what else was considered} |
