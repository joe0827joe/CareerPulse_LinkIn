"""Synthetic tests suitable for a public repository (no real resume targets)."""
import json
import unittest
from pathlib import Path

try:
    from pipeline import build_profile_contract as c, resume_diff as d
except ModuleNotFoundError:
    import build_profile_contract as c
    import resume_diff as d

class PublicCoreTests(unittest.TestCase):
    def test_contract_generator_uses_only_supplied_data(self):
        target = dict(profile_url='https://www.linkedin.com/in/example-person/', profile_locale='en_US',
                      shared_content_primary_locale='en_US', shared_content_operation_ids=['about'],
                      operations=[dict(id='about', section='about', operation='replace',
                                       url='https://www.linkedin.com/in/example-person/edit/about/',
                                       fields={'description':'Sample summary'}, evidence='Sample reviewed text',
                                       field_mapping={'description':{'labels':['About']}})])
        built=c.build_contract([target])
        self.assertEqual(built['profile']['public_profile_url'],target['profile_url'])
        self.assertFalse(built['restrictions']['direct_network_writes'])
        self.assertEqual(built['operations'][0]['fields']['description'],'Sample summary')
        ext=c.build_extension_targets([target])
        self.assertEqual(ext['operations']['en_US'][0]['id'],'about')

    def test_placeholder_schema_is_valid_json(self):
        base=Path(__file__).resolve().parents[1]
        obj=json.loads((base/'contracts/linkedin-profile-sync-contract.template.json').read_text(encoding='utf-8'))
        self.assertEqual(obj['artifact_type'],'linkedin_profile_sync_contract')

    def test_offline_diff_converges_on_verified_generic_snapshot(self):
        url='https://www.linkedin.com/in/example-person/'
        target=dict(artifact_type='linkedin_profile_patch',profile_url=url,profile_locale='en_US',shared_content_primary_locale='en_US',
                    shared_content_operation_ids=['about'],manual_follow_ups=[],
                    operations=[dict(id='about',section='about',operation='replace',url=url+'edit/about/',
                                     fields={'description':'Approved text'}, evidence='Reviewed text')])
        snapshot=dict(artifact_type='resume_snapshot',profile_url=url,records={'about':dict(exists=True,identity_confirmed=True,
                  fields={'description':dict(value='Approved text',complete=True,published_confirmed=True)})})
        result=d.compare(snapshot,target)
        self.assertEqual(result['changes'],[])
        self.assertTrue(result['target_diff_zero'])

    def test_text_normalization_does_not_mask_changes(self):
        self.assertNotEqual(d.norm('60%'),d.norm('6%'))
        self.assertNotEqual(d.norm('A B'),d.norm('AB'))

if __name__=='__main__':
    unittest.main()
