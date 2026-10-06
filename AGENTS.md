# AGENTS

## Project intent

This project should remain portable and not be tightly coupled to a single cloud provider. Cloudflare is currently used as one deployment option, but the app should be structured so that core functionality can run on other platforms with minimal change.

## Core preferences

- Prefer provider-neutral architecture over vendor-specific implementation.
- Keep business logic independent from Cloudflare-specific runtime APIs.
- Use standard web patterns: HTTP endpoints, environment variables, plain SQL or portable storage abstractions.
- Treat Cloudflare as an optional deployment target, not the architectural center of the app.
- Favor code that can be run locally and deployed elsewhere without major rewrites.
- Keep configuration in environment variables or configuration files, not hardcoded provider bindings.

## Architecture guidance

- Frontend HTML/CSS/JS should stay static and portable.
- API logic should be separated from UI concerns.
- Database access should be abstracted behind a simple portable interface.
- File and photo storage should be isolated behind a storage layer rather than direct provider calls.
- Secret management should use standard environment configuration, not platform-specific secret APIs when possible.
- Prefer simple, explicit modules for configuration, database access, and storage.

## Deployment guidance

- Cloudflare Workers are acceptable for current deployment, but not required for the app's design.
- If adding infrastructure code, prefer patterns that can be adapted to Docker, VPS, or other standard hosting.
- When implementing new features, consider whether they would still work with a generic Node server or alternate hosting environment.

## Coding expectations

- Keep code readable and framework-light.
- Avoid introducing provider-specific SDKs or deployment assumptions into the core app logic.
- Prefer maintainable abstractions over shortcuts that lock the project to one platform.
- If a feature depends on a Cloudflare resource, wrap it behind a generic interface so it can be swapped later.

## When making changes

- Preserve the app's portability goals.
- Do not add provider-specific dependencies unless they are clearly necessary and isolated.
- Prefer small, reusable modules over tightly-coupled cloud integration code.
- Keep future migration work in mind during refactors and new feature development.

## Example principles to follow

- Generic app logic first
- Provider-specific glue last
- Local development matters
- Environment-driven configuration matters
- Future portability is a feature
