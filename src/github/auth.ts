import type { App, Octokit } from 'octokit';

/** Octokit instance returned by app.getInstallationOctokit() (has paginate + REST). */
export type InstallationOctokit = Octokit;

export async function findInstallationForOrg(app: App, org: string): Promise<number> {
  const installations = await app.octokit.paginate('GET /app/installations', { per_page: 100 });
  const installation = installations.find((item) => item.account?.login === org);
  if (!installation) {
    throw new Error(`The GitHub App is not installed on "${org}" — install it and try again.`);
  }
  return installation.id;
}

// Installation-scoped Octokit + short-lived token, minted per-run for git clone/fetch URLs.
export async function createInstallationOctokit(
  app: App,
  org: string,
): Promise<{ octokit: InstallationOctokit; token: string }> {
  const installationId = await findInstallationForOrg(app, org);
  const octokit = await app.getInstallationOctokit(installationId);
  const auth = (await octokit.auth({ type: 'installation', installationId })) as { token: string };
  return { octokit, token: auth.token };
}
