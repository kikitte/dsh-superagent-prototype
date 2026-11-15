/** GitHub access identity is independent of the intake adapter. */
import { requireGitHub } from '../deployment.ts'
import type { SourceKind } from '../sources/kind.ts'
const SOURCE = 'github'
export const githubEnvironment: NonNullable<SourceKind['environment']> = {
    variables: [
      { key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', description: { zh: '这个来源监听的仓库，owner/name。智能体在这里开的 PR，分支最后一段是 DSH_SUPERAGENT_NAME 时（例如 agent/$DSH_SUPERAGENT_NAME）会关联到工单', en: 'The integration repository, as owner/name. With the GitHub adapter installed, an agent PR on this ticket branch can bind to the ticket; automatic tracking additionally requires intake on' } },
      { key: 'DSH_SUPERAGENT_GITHUB_ACCOUNT', description: { zh: '智能体的 GitHub 账号；gh 以它登录，除自动合并外的 GitHub 操作都用 gh，不用其他账号或凭据', en: 'The agent\'s GitHub account. gh is signed in to it; use gh for every GitHub operation except auto-merge, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Suggested GitHub commit email when neither task instructions nor executor.gitAuthor supplies an explicit identity' } },
      { key: 'DSH_SUPERAGENT_GITHUB_NUMBER', description: { zh: '接下工单的 Issue 或 PR 编号；工单不是从 GitHub 来的时为空', en: 'Number of the Issue or PR that started the ticket; empty when the ticket did not start on GitHub' } },
      { key: 'DSH_SUPERAGENT_GITHUB_PR_HEAD', description: { zh: '接下工单的 PR 的 head 引用 refs/pull/<编号>/head；不是 PR 时为空', en: 'Head ref refs/pull/<number>/head of the PR that started the ticket; empty when it was not a PR' } },
    ],
    values: ({ deployment, trigger }) => {
      const number = trigger?.threads[0]?.source === SOURCE ? Number(trigger.meta.number) || 0 : 0
      return { DSH_SUPERAGENT_GITHUB_REPOSITORY: requireGitHub(deployment).repository, DSH_SUPERAGENT_GITHUB_ACCOUNT: requireGitHub(deployment).login, DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: requireGitHub(deployment).noreply, DSH_SUPERAGENT_GITHUB_NUMBER: number ? String(number) : '',
        DSH_SUPERAGENT_GITHUB_PR_HEAD: number && trigger?.meta.isPr === true ? `refs/pull/${number}/head` : '' }
    },
  }
