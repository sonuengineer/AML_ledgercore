# AWS deployment -- Terraform

## Status: WRITTEN, NOT APPLIED, NOT VALIDATED

There is no Terraform binary, no AWS CLI and no AWS credentials on the machine
this was developed on. These files have therefore **never been run through
`terraform init`, `terraform validate` or `terraform plan`**, let alone
applied.

They are stated as reviewable design, not as working infrastructure. Expect
syntax errors, missing arguments and provider-version drift. Anyone picking
this up should run `terraform validate` first and assume it will fail at least
once.

Everything in the rest of this project was measured or executed; this is the
one part that was not, and saying so is more useful than implying otherwise.

## What IS proven locally

Two Phase 11 concerns were built and measured rather than designed:

- **pgBouncer** runs in `docker compose --profile scale` and its multiplexing
  was measured under load: 36 client connections onto 20 Postgres backends,
  zero waiting. See `deploy/pgbouncer/pgbouncer.ini`.
- **Role-level `statement_timeout` / `lock_timeout`**, after discovering that
  introducing pgBouncer silently disabled the Phase 10 connection-string
  version. See `prisma/migrations/*_role_level_timeouts`.

## Layout

```
  main.tf        providers, remote state, shared locals
  network.tf     VPC, subnets across 3 AZs, NAT, security groups
  data.tf        RDS PostgreSQL, ElastiCache Redis
  compute.tf     ECS cluster, API service, worker service, autoscaling
  edge.tf        ALB, ACM, CloudFront, Route 53
  observability.tf  CloudWatch log groups, alarms
  variables.tf   inputs
```

## The one thing to read first

`PHASE11_AWS.md` in the project root, section 3 -- the per-service
justification. Several services in the brief's suggested diagram are
deliberately **not** used, and the reasoning matters more than the HCL.
