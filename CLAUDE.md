# Claude Project Memory Template

**Primary Directive**: "Evidence > assumptions | Code > documentation | Efficiency > verbosity"

## Project Context

- **Current Branch**: `[BRANCH_NAME]` (if applicable)
- **Main Branch**: `[DEFAULT_BRANCH]` (for PRs)
- **Active Work**: `[CURRENT_FOCUS]` (if applicable)
- **Task Documents**: `[TASK_DOC_PATH]` (if applicable)

## Universal Execution Rules

### 1. Task Document Compliance

- **Read task documents COMPLETELY** before starting (if provided)
- **Follow specifications EXACTLY** when they exist
- **Do NOT deviate** from the specified plan without explicit approval
- **Ask for clarification** when requirements are unclear

### 2. Phase-by-Phase Execution

- **Work sequentially** - Complete current phase before moving to next
- **Respect dependencies** - Tasks often depend on previous completions
- **Use checkpoints** between phases (git commits/stash as appropriate)
- **Document progress** before moving to next phase

### 3. Testing & Validation

- **Test after changes** - Run project's test suite to verify
- **Zero tolerance for errors** - Code must pass all checks
- **Run specified tests** - Use project's testing framework
- **Validate before commit** - Ensure all checks pass

### 3. Quality Assurance

- **Validate deliverables** - Verify outputs meet specified requirements
- **Check completeness** - Ensure all requirements are addressed
- **Review before handoff** - Validate quality standards are met

### 4. Git Commit Strategy

- **Atomic commits** - One logical change per commit
- **Clear messages** - Follow project's commit format
- **Immediate commits** - Don't batch unless specified
- **No broken commits** - Each commit should leave code in working state

### 5. Documentation Updates

- **Update as you go** - Don't leave documentation for later
- **Record decisions** - Document why, not just what
- **Track issues** - Note any problems or deviations
- **Mark completions** - Update task status when done

## Subagent Guidance

### a. Failure Protocol

**STOP → REVERT → ANALYZE → ADJUST → RETRY → ESCALATE** (after 2 failures)

### b. Execution Strategy

- **Auto-delegate first** - Let Claude Code route tasks intelligently based on context
- **Explicit invoke** - Format: `"Use the [agent-name] subagent to [task description]"`
- **Parallel execution** - Max 3 concurrent agents for independent tasks
- **Sequential chains** - For dependent outputs: architect → developer → tester → reviewer

### c. Coordination Rules

- **Clear handoffs** - Document state changes between agents
- **Summarize results** - Present concise summary of subagent outputs to user
- **Resource management** - Terminate agents when expertise no longer needed
