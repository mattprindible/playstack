# playstack-ops

Operational scripts. Runs locally and in CI; never deployed.

```bash
cd tools
uv sync                       # create .venv from uv.lock, exactly

uv run playstack-ops status   # is everything up?
uv run playstack-ops seed -n 5
uv run playstack-ops audit-rls  # prove RLS is actually enforced
```

`uv run` syncs the environment before running, so there is no "did I activate
the venv?" step. You never source `activate` in this project.
