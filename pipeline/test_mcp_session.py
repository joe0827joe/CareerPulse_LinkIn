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
        self.assertTrue({'set_resume_plan','send_command','wait_result'} <= names)
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

    def test_pending_command_blocks_plan_switch(self):
        self.call('set_resume_plan', {'contract':self.plan})
        self.assertTrue(self.call('send_command', {'action':'scan'})['accepted'])
        self.assertIn('error',self.call('set_resume_plan', {'contract':self.plan}))


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

    def request(self, method, path, origin=None, payload=None, host=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        headers = {'Content-Type': 'application/json'}
        if origin is not None:
            headers['Origin'] = origin
        if host is not None:
            headers['Host'] = host
        conn.request(method, path, body=json.dumps(payload) if payload is not None else None, headers=headers)
        response = conn.getresponse()
        body = response.read()
        result = (response.status, dict(response.getheaders()), json.loads(body) if body else None)
        conn.close()
        return result

    def test_rejects_websites_missing_origin_and_wrong_extension(self):
        for origin in [None, 'https://www.linkedin.com', 'http://localhost:3000', 'chrome-extension://' + 'b'*32]:
            with self.subTest(origin=origin):
                status, headers, _ = self.request('GET', '/next', origin=origin)
                self.assertEqual(status, 403)
                self.assertNotIn('Access-Control-Allow-Origin', headers)
        status, _, _ = self.request('GET', '/next', origin=self.ALLOWED_ORIGIN,
                                   host=f'localhost:{self.port}')
        self.assertEqual(status, 403)

    def test_allows_approved_extension_without_wildcard_cors(self):
        status, headers, _ = self.request('OPTIONS', '/next', origin=self.ALLOWED_ORIGIN)
        self.assertEqual(status, 204)
        self.assertEqual(headers.get('Access-Control-Allow-Origin'), self.ALLOWED_ORIGIN)
        self.assertNotEqual(headers.get('Access-Control-Allow-Origin'), '*')
        status, _, _ = self.request('GET', '/next', origin=self.ALLOWED_ORIGIN)
        self.assertEqual(status, 204)

    def test_refuses_unknown_results_and_accepts_inflight_result(self):
        status, _, _ = self.request('POST', '/result', origin=self.ALLOWED_ORIGIN,
                                    payload={'id': 'not-issued', 'ok': True})
        self.assertEqual(status, 409)
        command = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                   'params': {'name': 'send_command', 'arguments': {'action': 'scan'}}}
        self.process.stdin.write(json.dumps(command)+'\n')
        self.process.stdin.flush()
        response = json.loads(self.process.stdout.readline())
        command_id = json.loads(response['result']['content'][0]['text'])['commandId']
        status, _, queued = self.request('GET', '/next', origin=self.ALLOWED_ORIGIN)
        self.assertEqual(status, 200)
        self.assertEqual(queued['id'], command_id)
        status, _, _ = self.request('POST', '/result', origin=self.ALLOWED_ORIGIN,
                                   payload={'id': command_id, 'ok': True, 'result': {'status': 'scanned'}})
        self.assertEqual(status, 200)
        status, _, _ = self.request('POST', '/result', origin=self.ALLOWED_ORIGIN,
                                   payload={'id': command_id, 'ok': True})
        self.assertEqual(status, 409)
        self.process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call',
                                             'params': {'name': 'wait_result', 'arguments': {'commandId': command_id}}})+'\n')
        self.process.stdin.flush()
        answer = json.loads(self.process.stdout.readline())
        self.assertTrue(json.loads(answer['result']['content'][0]['text'])['ok'])