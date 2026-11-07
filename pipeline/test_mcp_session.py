"""Exercise the real stdio MCP process without a browser or a resume workspace."""
import copy
import json
import http.client
import os
from pathlib import Path
import subprocess
import unittest

SERVER = Path(__file__).resolve().parents[1] / 'linkedin-profile-audit-extension-2.1.1/codex-plugin/linkedin-profile-resume-sync/server.mjs'


class McpSessionTests(unittest.TestCase):
    def setUp(self):
        self.process = subprocess.Popen(['node', str(SERVER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', env={**os.environ, 'LINKEDIN_RESUME_PORT': '0', 'LINKEDIN_RESUME_WORKSPACE': ''})
        self.port = int(self.process.stderr.readline().strip().rsplit(':', 1)[-1])
        self.plan = {'profile': {'public_profile_url': 'https://www.linkedin.com/in/test-person/'}, 'locales': ['en_US'], 'operations': []}

    def tearDown(self):
        self.process.stdin.close()
        self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()

    def call(self, name, args=None):
        self.process.stdin.write(json.dumps({'jsonrpc':'2.0', 'id':1, 'method':'tools/call', 'params':{'name':name, 'arguments':args or {}}})+'\n')
        self.process.stdin.flush()
        response = json.loads(self.process.stdout.readline())
        if 'error' in response:
            return response
        return json.loads(response['result']['content'][0]['text'])

    def test_tools_advertise_agent_driven_discovery(self):
        self.process.stdin.write(json.dumps({'jsonrpc':'2.0', 'id':1, 'method':'tools/list'})+'\n')
        self.process.stdin.flush()
        response=json.loads(self.process.stdout.readline())
        names={item['name'] for item in response['result']['tools']}
        self.assertTrue({'set_resume_plan','send_command','wait_result','begin_bridge_pairing'} <= names)
        command=next(item for item in response['result']['tools'] if item['name']=='send_command')
        self.assertTrue({'inspect_page','activate_control'} <= set(command['inputSchema']['properties']['action']['enum']))

    def test_new_user_needs_no_workspace(self):
        self.assertFalse(self.call('workspace_status')['configured'])
        self.assertTrue(self.call('set_resume_plan', {'contract':self.plan})['accepted'])
        self.assertTrue(self.call('contract_status')['healthy'])
        self.assertEqual(self.call('read_extension_targets')['operations'], {'en_US':[]})

    def test_arbitrary_sections_and_fields_and_profile_switch(self):
        op = {'id':'credential', 'locale':'en_US', 'section':'certifications', 'operation':'replace', 'url':self.plan['profile']['public_profile_url']+'edit/credential/', 'fields':{'credential_name':'Example'}, 'field_mapping':{'credential_name':{'labels':['Credential name']}}}
        self.plan['operations'] = [op]
        self.assertTrue(self.call('set_resume_plan', {'contract':self.plan})['accepted'])
        self.assertEqual(self.call('read_extension_targets')['operations']['en_US'][0]['fields'], op['fields'])
        other=copy.deepcopy(self.plan)
        other['profile']['public_profile_url']='https://www.linkedin.com/in/other-person/'
        other['operations']=[]
        self.assertTrue(self.call('set_resume_plan', {'contract':other})['accepted'])
        self.assertEqual(self.call('read_contract')['profile'], other['profile'])

    def test_invalid_plan_does_not_replace_previous(self):
        self.call('set_resume_plan', {'contract':self.plan})
        invalid=copy.deepcopy(self.plan)
        invalid['operations']=[{'id':'education','locale':'en_US','section':'education','operation':'replace','url':'https://www.linkedin.com/in/somebody-else/edit/','fields':{'degree':'PhD'}}]
        self.assertIn('error', self.call('set_resume_plan', {'contract':invalid}))
        self.assertEqual(self.call('read_contract')['operations'], [])

    def test_unmapped_field_and_create_without_identity_rejected(self):
        op={'id':'education','locale':'en_US','section':'education','operation':'replace','url':self.plan['profile']['public_profile_url']+'edit/', 'fields':{'degree':'Example'}}
        self.plan['operations']=[op]
        self.assertIn('error', self.call('set_resume_plan', {'contract':self.plan}))

    def test_native_multi_select_values_are_validated(self):
        op={'id':'languages','locale':'en_US','section':'languages','operation':'replace','url':self.plan['profile']['public_profile_url']+'edit/', 'fields':{'proficiencies':['English','Chinese']}, 'field_mapping':{'proficiencies':{'labels':['Proficiencies']}}}
        self.plan['operations']=[op]
        self.assertTrue(self.call('set_resume_plan', {'contract':self.plan})['accepted'])
        op['fields']['proficiencies']=[]
        self.assertIn('error', self.call('set_resume_plan', {'contract':self.plan}))
        op['field_mapping']={'degree':{'labels':['Degree']}}
        op['operation']='create'
        self.assertIn('error', self.call('set_resume_plan', {'contract':self.plan}))

    def test_protocol_reports_plugin_manifest_version(self):
        manifest = SERVER.parent / 'plugin.json'
        expected = json.loads(manifest.read_text(encoding='utf-8'))['version']
        self.process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}})+'\n')
        self.process.stdin.flush()
        response = json.loads(self.process.stdout.readline())
        self.assertEqual(response['result']['serverInfo']['version'], expected)

    def test_unpaired_command_rejected_without_queuing(self):
        self.call('set_resume_plan', {'contract':self.plan})
        self.assertIn('error', self.call('send_command', {'action':'scan'}))
        self.assertTrue(self.call('set_resume_plan', {'contract':self.plan})['accepted'])
        self.assertEqual(self.call('bridge_status')['queued'], 0)



class BridgeHttpTests(unittest.TestCase):
    """HTTP integration checks against a real local server; no browser required."""

    EXTENSION_ID = 'a' * 32
    ALLOWED_ORIGIN = 'chrome-extension://' + EXTENSION_ID

    def setUp(self):
        env = {**os.environ, 'LINKEDIN_RESUME_PORT': '0',
               'LINKEDIN_RESUME_EXTENSION_ID': self.EXTENSION_ID,
               'LINKEDIN_RESUME_WORKSPACE': ''}
        self.process = subprocess.Popen(['node', str(SERVER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, encoding='utf-8', env=env)
        announcement = self.process.stderr.readline().strip()
        self.assertIn('bridge listening on 127.0.0.1:', announcement)
        self.port = int(announcement.rsplit(':', 1)[-1])

    def tearDown(self):
        self.process.stdin.close()
        self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()

    def mcp(self, name, args=None):
        self.process.stdin.write(json.dumps({'jsonrpc':'2.0', 'id':1, 'method':'tools/call',
            'params':{'name':name, 'arguments':args or {}}})+'\n')
        self.process.stdin.flush()
        response = json.loads(self.process.stdout.readline())
        if 'error' in response:
            return response
        return json.loads(response['result']['content'][0]['text'])

    def request(self, method, path, origin=None, payload=None, host=None, token=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        headers = {'Content-Type': 'application/json'}
        if origin is not None:
            headers['Origin'] = origin
        if host is not None:
            headers['Host'] = host
        if token is not None:
            headers['X-Bridge-Token'] = token
        conn.request(method, path, body=json.dumps(payload) if payload is not None else None, headers=headers)
        response = conn.getresponse()
        body = response.read()
        result = (response.status, dict(response.getheaders()), json.loads(body) if body else None)
        conn.close()
        return result

    def pair(self):
        status, _, _ = self.request('POST', '/pair', origin=self.ALLOWED_ORIGIN,
            payload={'pairingCode':'not-valid'})
        self.assertEqual(status, 403)
        invitation = self.mcp('begin_bridge_pairing')
        self.assertEqual(invitation['expiresInSeconds'], 120)
        status, _, data = self.request('POST', '/pair', origin=self.ALLOWED_ORIGIN,
                                      payload={'pairingCode':invitation['pairingCode']})
        self.assertEqual(status, 200)
        self.assertTrue(data['ok'])
        self.assertGreaterEqual(len(data['token']), 40)
        self.assertTrue(self.mcp('bridge_status')['paired'])
        return data['token']

    def test_rejects_websites_missing_origin_and_wrong_extension(self):
        for origin in [None, 'https://www.linkedin.com', 'http://localhost:3000', 'chrome-extension://' + 'b'*32]:
            with self.subTest(origin=origin):
                status, headers, _ = self.request('GET', '/next', origin=origin)
                self.assertEqual(status, 403)
                self.assertNotIn('Access-Control-Allow-Origin', headers)
        status, _, _ = self.request('GET', '/next', origin=self.ALLOWED_ORIGIN,
                                   host=f'localhost:{self.port}')
        self.assertEqual(status, 403)

    def test_preflight_and_unpaired_requests_are_not_authenticated(self):
        status, headers, _ = self.request('OPTIONS', '/next', origin=self.ALLOWED_ORIGIN)
        self.assertEqual(status, 204)
        self.assertEqual(headers['Access-Control-Allow-Origin'], self.ALLOWED_ORIGIN)
        self.assertIn('X-Bridge-Token', headers['Access-Control-Allow-Headers'])
        self.assertNotEqual(headers['Access-Control-Allow-Origin'], '*')
        for endpoint in ['/next', '/health']:
            status, _, _ = self.request('GET', endpoint, origin=self.ALLOWED_ORIGIN)
            self.assertEqual(status, 401)
        self.assertFalse(self.mcp('bridge_status')['paired'])
        self.assertIn('error', self.mcp('send_command', {'action': 'scan'}))
        self.assertEqual(self.mcp('bridge_status')['queued'], 0)

    def test_wrong_code_code_replay_and_token_rotation(self):
        token=self.pair()
        status, _, _ = self.request('GET', '/health', origin=self.ALLOWED_ORIGIN,
                                    token=token)
        self.assertEqual(status, 200)
        status, _, _ = self.request('GET', '/next', origin=self.ALLOWED_ORIGIN,
                                    token='wrong token')
        self.assertEqual(status, 401)
        status, _, _ = self.request('GET', '/health', origin='chrome-extension://' + 'b'*32,
                                    token=token)
        self.assertEqual(status, 403)
        status, _, _ = self.request('POST', '/pair', origin=self.ALLOWED_ORIGIN,
                                   payload={'pairingCode':'not-valid'})
        self.assertEqual(status, 403)
        invite=self.mcp('begin_bridge_pairing')
        status, _, _=self.request('GET','/health',origin=self.ALLOWED_ORIGIN,token=token)
        self.assertEqual(status,401)
        status, _, pairResponse=self.request('POST','/pair',origin=self.ALLOWED_ORIGIN,
                                     payload={'pairingCode':invite['pairingCode']})
        self.assertEqual(status,200)
        self.assertNotEqual(token,pairResponse['token'])
        status, _, _=self.request('POST','/pair',origin=self.ALLOWED_ORIGIN,
                                     payload={'pairingCode':invite['pairingCode']})
        self.assertEqual(status,403)

    def test_repeated_wrong_codes_lockout(self):
        invite=self.mcp('begin_bridge_pairing')
        for _ in range(5):
            status, _, _=self.request('POST','/pair',origin=self.ALLOWED_ORIGIN,
                                      payload={'pairingCode':'some-incorrect-code'})
            self.assertEqual(status,403)
        status, _, _=self.request('POST','/pair',origin=self.ALLOWED_ORIGIN,
                                      payload={'pairingCode':invite['pairingCode']})
        self.assertEqual(status,403)

    def test_refuses_unknown_results_and_accepts_inflight_result(self):
        token=self.pair()
        status, _, _ = self.request('POST', '/result', origin=self.ALLOWED_ORIGIN,
                                    token=token, payload={'id': 'not-issued', 'ok': True})
        self.assertEqual(status, 409)
        response=self.mcp('send_command', {'action': 'scan'})
        self.assertTrue(response['accepted'])
        command_id=response['commandId']
        self.assertIn('error', self.mcp('begin_bridge_pairing'))
        self.assertIn('error', self.mcp('set_resume_plan',
            {'contract': {'profile': {'public_profile_url': 'https://www.linkedin.com/in/test-person/'},
                          'locales': ['en_US'], 'operations': []}}))
        status, _, _ = self.request('GET', '/next', origin=self.ALLOWED_ORIGIN)
        self.assertEqual(status, 401)
        status, _, queued = self.request('GET', '/next', origin=self.ALLOWED_ORIGIN,token=token)
        self.assertEqual(status, 200)
        self.assertEqual(queued['id'], command_id)
        status, _, _ = self.request('POST', '/result', origin=self.ALLOWED_ORIGIN,
                                   token='invalid',payload={'id': command_id, 'ok': True})
        self.assertEqual(status,401)
        status, _, _ = self.request('POST', '/result', origin=self.ALLOWED_ORIGIN,
                                   token=token,payload={'id': command_id, 'ok': True, 'result': {'status': 'scanned'}})
        self.assertEqual(status, 200)
        status, _, _ = self.request('POST', '/result', origin=self.ALLOWED_ORIGIN,
                                   token=token, payload={'id': command_id, 'ok': True})
        self.assertEqual(status, 409)
        answer=self.mcp('wait_result', {'commandId': command_id})
        self.assertTrue(answer['ok'])

    def test_forced_repair_cancels_stranded_commands(self):
        old_token=self.pair()
        pending=self.mcp('send_command', {'action':'scan'})['commandId']
        self.assertIn('error',self.mcp('begin_bridge_pairing'))
        renewed=self.mcp('begin_bridge_pairing',{'force':True})
        self.assertEqual(renewed['cancelledCommands'],1)
        self.assertFalse(self.mcp('bridge_status')['paired'])
        self.assertEqual(self.mcp('bridge_status')['queued'],0)
        result=self.mcp('wait_result',{'commandId':pending})
        self.assertFalse(result['ok'])
        self.assertIn('cancelled',result['error'])
        status, _, _=self.request('GET','/next',origin=self.ALLOWED_ORIGIN,token=old_token)
        self.assertEqual(status,401)
        status, _, data=self.request('POST','/pair',origin=self.ALLOWED_ORIGIN,
                  payload={'pairingCode':renewed['pairingCode']})
        self.assertEqual(status,200)
        self.assertNotEqual(old_token,data['token'])

    def test_extension_popup_is_packaged_and_session_token_stays_in_worker(self):
        root=SERVER.parents[2]
        manifest=json.loads((root/'manifest.json').read_text(encoding='utf-8'))
        self.assertIn('storage',manifest['permissions'])
        release=(root.parent/'package-release.ps1').read_text(encoding='utf-8')
        self.assertIn("'popup.html'",release)
        self.assertIn("'popup.js'",release)
        self.assertIn("$ExtensionVersion = '4.12.0'",release)
        popup=manifest['action']['default_popup']
        self.assertTrue((root/popup).is_file())
        self.assertTrue((root/'popup.js').is_file())
        background=(root/'background.js').read_text(encoding='utf-8')
        self.assertIn("chrome.storage.session.get('bridgeToken')",background)
        self.assertIn("bridgeFetch('/next'",background)
