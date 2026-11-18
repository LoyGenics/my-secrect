require 'rails_helper'

RSpec.describe 'Import previews', type: :request do
  let(:path) { '/api/v1/imports/preview' }
  let(:headers) { auth_headers_for(create(:user)) }
  let(:source_text) { "Example login\nPassword: synthetic-import-value" }
  let(:media_type) { { 'CONTENT_TYPE' => 'application/vnd.my-secret.import+json' } }

  def submit(body, url: path, auth: headers)
    post url, params: body.to_json, headers: auth.merge(media_type)
  end

  it 'requires account authentication and explicit consent in the JSON body' do
    expect(Imports::OpenAiPreview).not_to receive(:call)
    submit({ source_text: source_text, consent: true }, auth: {})
    expect(response).to have_http_status(:unauthorized)

    submit({ source_text: source_text }, url: "#{path}?consent=true")
    expect(response).to have_http_status(:unprocessable_entity)

    submit({ source_text: source_text, consent: 'true' })
    expect(response).to have_http_status(:unprocessable_entity)

    submit({ source_text: 'a' * 16_385, consent: true })
    expect(response).to have_http_status(:unprocessable_entity)
  end

  it 'requests non-persisted schema output and filters source text from logs' do
    allow(ENV).to receive(:[]).and_call_original
    allow(ENV).to receive(:[]).with('OPENAI_API_KEY').and_return('test-placeholder')
    allow(ENV).to receive(:[]).with('OPENAI_IMPORT_MODEL').and_return(nil)

    items = [{ 'type' => 'login', 'title' => 'Example login',
               'fields' => { 'username' => nil, 'password' => 'synthetic-import-value',
                             'url' => nil, 'totp_secret' => nil, 'notes' => nil } }]
    upstream = Net::HTTPOK.new('1.1', '200', 'OK')
    allow(upstream).to receive(:body).and_return({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: { items: items }.to_json }] }]
    }.to_json)
    connection = instance_double(Net::HTTP)
    expect(Net::HTTP).to receive(:start).with('api.openai.com', 443, hash_including(use_ssl: true)).and_yield(connection)
    expect(connection).to receive(:request) do |request|
      expect(request.path).to eq('/v1/responses')
      payload = JSON.parse(request.body)
      expect(payload).to include('input' => source_text, 'store' => false)
      expect(payload.dig('text', 'format')).to include('type' => 'json_schema', 'strict' => true)
      upstream
    end

    log = StringIO.new
    capture = ActiveSupport::Logger.new(log)
    capture.level = :debug
    Rails.logger.broadcast_to(capture)
    submit({ source_text: source_text, consent: true })
    expect(response).to have_http_status(:ok)
    expect(response.headers.fetch('Cache-Control')).to eq('no-store')
    expect(JSON.parse(response.body)).to eq('items' => items)
    post path, params: '{"source_text":"synthetic-import-value', headers: headers.merge(media_type)
    expect(response).to have_http_status(:unprocessable_entity)
    expect(log.string).not_to include('synthetic-import-value')
  ensure
    Rails.logger.stop_broadcasting_to(capture) if capture
  end

  it 'returns a generic error when the upstream fails' do
    allow(Imports::OpenAiPreview).to receive(:call).and_raise(Imports::OpenAiPreview::Failed, source_text)
    submit({ source_text: source_text, consent: true })
    expect(response).to have_http_status(:bad_gateway)
    expect(JSON.parse(response.body)).to eq('error' => 'ai_import_failed')
  end
end
