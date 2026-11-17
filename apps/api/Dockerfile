# Build context is apps/api (see infra/docker/docker-compose.yml).
FROM ruby:3.3-slim
# libsodium23 is required at runtime by rbnacl (recovery-key signatures).
RUN apt-get update -qq && apt-get install -y build-essential libpq-dev curl libsodium23 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Gemfile Gemfile.lock* ./
ENV BUNDLE_WITHOUT=development:test
RUN bundle install
COPY . ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://localhost:3000/health || exit 1
# No bin/rails in this API-only app (`rails server` would run the app generator).
CMD ["bundle", "exec", "puma", "-C", "config/puma.rb", "-b", "tcp://0.0.0.0:3000"]
