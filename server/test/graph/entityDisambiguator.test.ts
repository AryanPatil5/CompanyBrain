import { canonicalizeEntity, disambiguateTriple } from '../../src/services/graph/entityDisambiguator.js';
import { GraphTriple } from '../../src/services/graph/ontologyCompiler.js';

export async function runEntityDisambiguatorTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Entity Disambiguator Test Suite       ');
  console.log('=================================================');

  // 1. Test Synonyms & Alias Dictionary Lookup
  const pgCanonical = canonicalizeEntity('PostgreSQL Primary', 'System');
  const k8sCanonical = canonicalizeEntity('k8s cluster', 'System');
  const stripeCanonical = canonicalizeEntity('Stripe Payments', 'System');

  if (pgCanonical !== 'postgresql_db' || k8sCanonical !== 'kubernetes' || stripeCanonical !== 'stripe_api') {
    console.error('❌ DISAMBIGUATOR TEST FAILED: Synonym canonicalization mismatch!', { pgCanonical, k8sCanonical, stripeCanonical });
    return false;
  }
  console.log('✅ DISAMBIGUATOR TEST PASSED: Synonyms ("PostgreSQL Primary", "k8s cluster", "Stripe Payments") canonicalized correctly.');

  // 2. Test Triple Disambiguation & Metadata Preservation
  const rawTriple: GraphTriple = {
    subject: 'Postgres',
    subjectType: 'System',
    predicate: 'DEPENDS_ON',
    object: 'S3 Bucket',
    objectType: 'System',
  };

  const disambiguated = disambiguateTriple(rawTriple);

  if (disambiguated.subject !== 'postgresql_db' || disambiguated.object !== 's3_storage') {
    console.error('❌ DISAMBIGUATOR TEST FAILED: Triple subject/object canonicalization failed!', disambiguated);
    return false;
  }

  if (disambiguated.metadata?.rawSubject !== 'Postgres' || disambiguated.metadata?.rawObject !== 'S3 Bucket') {
    console.error('❌ DISAMBIGUATOR TEST FAILED: Raw subject/object string metadata was not preserved!', disambiguated.metadata);
    return false;
  }

  console.log('✅ DISAMBIGUATOR TEST PASSED: Disambiguated GraphTriple subject/object and preserved raw string metadata.');
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runEntityDisambiguatorTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
