/**
 * 可选：用 testcontainers 拉起一个自包含的 Conductor 镜像（CI 场景）。
 * 注意：payload 阈值、超时检测周期都取决于服务端配置，正式结论应以你们自建环境为准。
 */
export async function startConductorContainer(image: string): Promise<{ url: string; stop: () => Promise<void> }> {
  let tc: typeof import('testcontainers');
  try {
    tc = await import('testcontainers');
  } catch {
    throw new Error('未安装 testcontainers。请 npm i -D testcontainers，或改用 CONDUCTOR_URL 指向已有环境。');
  }
  const container = await new tc.GenericContainer(image)
    .withExposedPorts(8080)
    .withWaitStrategy(tc.Wait.forHttp('/api/metadata/taskdefs', 8080).forStatusCode(200))
    .withStartupTimeout(300_000)
    .start();
  return {
    url: `http://${container.getHost()}:${container.getMappedPort(8080)}/api`,
    stop: async () => {
      await container.stop();
    },
  };
}
