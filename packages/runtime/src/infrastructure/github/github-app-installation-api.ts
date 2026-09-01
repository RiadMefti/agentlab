export interface CreateGitHubAppInstallationTokenInput {
  readonly installationId: number;
  readonly repositoryNumericId: number;
  readonly jwt: string;
}

export interface GitHubAppInstallationApi {
  createToken(input: CreateGitHubAppInstallationTokenInput): Promise<unknown>;
}
