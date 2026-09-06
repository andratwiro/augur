# A COLD MACHINE for the first-experience run: Node, git, curl, the Claude Code CLI, and
# nothing else — no engine clone, no ~/.config/augur, no draft registry, no memory of any
# earlier session. The agent inside starts from an empty folder with only the workspace
# link and the task, and every credential it ends up holding it obtained the way a
# stranger would. (The first run on the host machine was not cold: the agent found this
# suite's cached tokens and the engine clone on disk within a minute and never paired.)
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates python3 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code \
 && useradd -m -s /bin/bash person
USER person
WORKDIR /home/person/work
ENV HOME=/home/person
# The relay copies a short-lived access token into ~/.claude/.credentials.json at start;
# it carries NO refresh token, so nothing in here can rotate the host's credential.
CMD ["sleep", "infinity"]
