# apps/grove/infra: agent instructions

The root `AGENTS.md` and `apps/grove/AGENTS.md` apply here. This file holds what differs for Terraform.

- `environments/staging` and `environments/production` are the roots; `modules/` holds what they
  compose. A module is validated only through the roots that supply its variables.
- `typecheck` is `scripts/terraform-validate.mjs`, which runs `init -backend=false` then `validate` in
  each root, so it needs no credential. `format` is `terraform fmt -recursive`.
- The Terraform version CI uses is the `terraform_version` in `.github/workflows/ci.yml`.
- Never run `plan` or `apply` from a session: both reach a real AWS account through the remote state
  backend, and `apply` changes what players are connected to.
- `README.md` here is this package's contract; a resource whose purpose changes is edited there in
  the same commit.
