"""Read-only native oracle for the view differential test. Never used at runtime."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'gen'))
import _odoo
from odoo.tools import json_default
import phonenumbers
from unittest.mock import patch
from types import SimpleNamespace

database = os.environ['ODOO_TEST_DB']
if not database.startswith(('dev_', 'live_', 'run_')):
    raise ValueError('Use an existing scratch copy, not a template.')

cases = []
with _odoo.env(database) as env:
    from odoo.addons.phone_validation.tools.phone_validation import phone_format
    from odoo.addons.mail.tools.discuss import Store
    from odoo.addons.mail.controllers.discuss.messaging_menu import DiscussMessagingMenuController
    from odoo.addons.mail.controllers.messaging_menu import MessagingMenuController
    from odoo.addons.mail.controllers.webclient import WebclientController
    for login, lang in [('admin', 'en_US'), ('admin', 'fr_FR'), ('be_user', 'en_US')]:
        # Each case represents a new HTTP request. Computed display names may
        # otherwise reuse the preceding request's non-contextual ORM cache.
        env.invalidate_all()
        user = env['res.users'].search([('login', '=', login)])
        if not user:
            raise ValueError(f'Missing test user {login}')
        context = {'lang': lang, 'tz': 'UTC', 'allowed_company_ids': user.company_ids.ids}
        partner = env['res.partner'].with_user(user).with_context(context)
        views = [[False, kind] for kind in ('list', 'form', 'kanban', 'search', 'hierarchy')]
        options = {'toolbar': True, 'load_filters': True}
        with open(os.path.join(os.path.dirname(__file__), 'contacts-request.json')) as source:
            request = json.load(source)
        request['kwargs']['context'] = context
        kwargs = {k: v for k, v in request['kwargs'].items() if k != 'context'}
        with open(os.path.join(os.path.dirname(__file__), 'contact-form-request.json')) as source:
            form_request = json.load(source)
        form_request['kwargs']['context'] = context
        # Exercise the form specification on every accessible contact, including
        # blacklist/VAT edge cases and both companies, not just one screen.
        form_request['args'] = [partner.search([]).ids]
        form = partner.browse(form_request['args'][0]).web_read(form_request['kwargs']['specification'])
        searches = []
        for operator, value in [('ilike', '555'), ('ilike', '+32 2'), ('ilike', '0032 2'), ('=', False), ('=', True), ('ilike', ' 555 '), ('=like', '555')]:
            domain = [('phone_mobile_search', operator, value)]
            searches.append({'domain': domain, 'ids': partner.search(domain).ids})
        env.cr.execute('SELECT extract(epoch from now())')
        clock = float(env.cr.fetchone()[0])
        with patch('time.time', return_value=clock):
            bootstrap = Store().add_global_values(user.with_user(user).with_context(context)._store_init_global_fields).as_dict()
            current = partner.env
            channels = current['discuss.channel'].search([('channel_member_ids', 'any', [('is_self', '=', True), ('rtc_inviting_session_id', '!=', False)])])
            if current.user._is_internal():
                channels |= current['discuss.channel'].search([('channel_type', '=', 'chat'), ('is_member', '=', True), ('channel_member_ids.partner_id', '=', current.ref('base.partner_root').id)])
            initial_channels = Store().add(channels, '_store_channel_fields').add(channels.self_member_id, ['is_favorite']).as_dict()
            class Menu(DiscussMessagingMenuController, MessagingMenuController):
                @property
                def env(self):
                    return current
            tabs = {'chat': None, 'channel': None, 'meeting': 'meeting_today'}
            counters = Store()
            Menu().store_messaging_menu_initialize_counters(counters, {'discuss.channel': tabs})
            counters = counters.as_dict()
            failure_store, activity_store = Store(), Store()
            with patch('odoo.addons.mail.controllers.webclient.request', SimpleNamespace(env=current)):
                WebclientController().store_get_failures(failure_store)
                WebclientController().store_systray_get_activities(activity_store)
                failure_store, activity_store = failure_store.as_dict(), activity_store.as_dict()
            with open(os.path.join(os.path.dirname(__file__), 'chatter-requests.json')) as source:
                chatter_inputs = json.load(source)
            chatter = []
            for chatter_input in chatter_inputs:
                fetch, thread_request = chatter_input['fetch_params']
                target = current[thread_request[1]['thread_model']].browse(thread_request[1]['thread_id'])
                if not target.has_access('read'):
                    continue
                messages = current['mail.message']._message_fetch(None, thread=target, **fetch[1]['fetch_params'])['messages']
                output = Store()
                output.data_id = fetch[2]
                output.resolve_data_request(lambda res: res.many('messages', [], value=messages))
                output.data_id = None
                output.add(target, '_store_thread_fields', fields_params={'request_list': thread_request[1]['request_list'], 'chatter_fields': True}, as_thread=True)
                output.add(messages, '_store_message_fields', fields_params={'chatter_fields': True})
                chatter.append({'id': target.id, 'data_id': fetch[2], 'fetch': fetch[1]['fetch_params'], 'request_list': thread_request[1]['request_list'], 'result': output.as_dict()})
        cases.append({
            'login': login, 'uid': user.id, 'context': context, 'views': views, 'options': options,
            'fields': partner.fields_get(attributes=partner._get_view_field_attributes()),
            'result': partner.get_views(views, options),
            'request': request, 'contacts': partner.web_search_read(**kwargs),
            'bootstrap': bootstrap,
            'initial_channels': initial_channels, 'counters': counters, 'tabs': tabs,
            'failures': failure_store, 'activities': activity_store,
            'form_request': form_request, 'form': form,
            'chatter': chatter,
            'searches': searches,
        })
    numbers = set(env['res.partner'].search([]).mapped('phone_sanitized')) - {False}
    # General library examples exercise countries and number types outside the corpus.
    for region in phonenumbers.SUPPORTED_REGIONS:
        for kind in phonenumbers.PhoneNumberType.values():
            example = phonenumbers.example_number_for_type(region, kind)
            if example:
                numbers.add(phonenumbers.format_number(example, phonenumbers.PhoneNumberFormat.E164))
    phones = [[n, phone_format(n, None, None, force_format='INTERNATIONAL', raise_exception=False)] for n in sorted(numbers)]
with open(os.environ['ODOO_VIEWS_ORACLE'], 'w') as output:
    json.dump({'cases': cases, 'phones': phones}, output, default=json_default)
print(f'Native read oracle: {len(cases)} view/contact cases, {len(phones)} phone examples, rolled back')
