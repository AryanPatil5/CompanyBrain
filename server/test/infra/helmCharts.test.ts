import fs from 'fs';
import path from 'path';

export async function runHelmChartsTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Kubernetes Helm Chart Validation Test ');
  console.log('=================================================');

  const helmRootDir = path.resolve(process.cwd(), '../deploy/helm/company-brain');

  const requiredFiles = [
    'Chart.yaml',
    'values.yaml',
    'templates/deployment.yaml',
    'templates/worker-deployment.yaml',
    'templates/service.yaml',
  ];

  for (const fileRel of requiredFiles) {
    const fullPath = path.join(helmRootDir, fileRel);
    if (!fs.existsSync(fullPath)) {
      console.error(`❌ HELM CHART TEST FAILED: Missing required file: ${fileRel}`);
      return false;
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    if (!content || content.trim().length === 0) {
      console.error(`❌ HELM CHART TEST FAILED: File is empty: ${fileRel}`);
      return false;
    }
  }

  // Verify Chart.yaml metadata
  const chartYaml = fs.readFileSync(path.join(helmRootDir, 'Chart.yaml'), 'utf-8');
  if (!chartYaml.includes('name: company-brain') || !chartYaml.includes('apiVersion: v2')) {
    console.error('❌ HELM CHART TEST FAILED: Chart.yaml invalid content!', chartYaml);
    return false;
  }

  // Verify values.yaml config
  const valuesYaml = fs.readFileSync(path.join(helmRootDir, 'values.yaml'), 'utf-8');
  if (!valuesYaml.includes('replicaCount:') || !valuesYaml.includes('/health') || !valuesYaml.includes('/metrics')) {
    console.error('❌ HELM CHART TEST FAILED: values.yaml missing probes or replica config!', valuesYaml);
    return false;
  }

  console.log('✅ HELM CHART TEST PASSED: All Kubernetes Helm chart manifests (Chart, values, API deployment, worker deployment, service) verified successfully.');
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHelmChartsTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
