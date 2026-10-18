/**
 * BYOK API Key Manager — stores keys in localStorage ONLY.
 * Keys never leave the user's browser. Never sent to any server.
 *
 * Configure AI_SERVICES below for the services this tool uses.
 */
const ApiKeyManager = (function() {
  const STORAGE_PREFIX = 'despesas-ia_apikey_';

  const AI_SERVICES = {
    openai: {
      name: 'OpenAI',
      placeholder: 'sk-...',
      helpUrl: 'https://platform.openai.com/api-keys',
      prefix: 'sk-',
      required: false
    },
    anthropic: {
      name: 'Anthropic (Claude)',
      placeholder: 'sk-ant-...',
      helpUrl: 'https://console.anthropic.com/',
      prefix: 'sk-ant-',
      required: false
    },
    gemini: {
      name: 'Google (Gemini)',
      placeholder: 'AIza...',
      helpUrl: 'https://aistudio.google.com/apikey',
      prefix: 'AIza',
      required: false
    },
    openrouter: {
      name: 'OpenRouter',
      placeholder: 'sk-or-...',
      helpUrl: 'https://openrouter.ai/keys',
      prefix: 'sk-or-',
      required: false
    },
    fal: {
      name: 'FAL.AI',
      // Real fal keys look like "<uuid>:<hex>" (e.g. 1a2b3c...:9f8e...). No fixed prefix.
      placeholder: 'xxxxxxxx-xxxx-...:xxxxxxxx',
      helpUrl: 'https://fal.ai/dashboard/keys',
      prefix: '',
      required: false
    }
  };

  // Which services this specific tool uses — set during scaffold
  // Modify this array to include only the services needed
  const ENABLED_SERVICES = ['openrouter']; // openrouter (multi-model via OpenRouter)

  // ── Model catalog (Hard Rule #19 + protocols/model-selection.md) ──
  // For tools with a MODEL PICKER. Grouped by provider so the user can pick
  // across Claude / OpenAI / Google / DeepSeek + current trending OpenRouter
  // models. Route through OpenRouter so ONE BYOK key reaches every provider —
  // ids are OpenRouter provider-prefixed (e.g. "openai/gpt-4o").
  //
  // ⚠ REFRESH PER BUILD: this is a STARTER list. Before wiring a picker, fetch
  // the LIVE ranking (https://openrouter.ai/api/v1/models or /rankings) and
  // replace the "trending" group + bump any superseded flagships. The field
  // moves weekly — do not ship this list stale.
  // Verified live against GET https://openrouter.ai/api/v1/models on 2026-10-18 (COR-048) — despesas-ia build.
  // SOMENTE modelos com entrada de IMAGEM (architecture.input_modalities inclui "image"):
  // a ferramenta envia a foto de cada comprovante para o modelo ler.
  const AI_MODELS = {
    claude: {
      label: 'Claude (Anthropic)',
      models: [
        { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5' },
        { id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5 (rápido e barato)' },
        { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5 (máxima precisão)' }
      ]
    },
    openai: {
      label: 'OpenAI',
      models: [
        { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol' },
        { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna (econômico)' },
        { id: 'openai/gpt-6-sol', name: 'GPT-6 Sol' }
      ]
    },
    google: {
      label: 'Google (Gemini)',
      models: [
        { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash (recomendado p/ lotes)' },
        { id: 'google/gemini-4-argon', name: 'Gemini 4 Argon' },
        { id: 'google/gemini-3.7-flash', name: 'Gemini 3.7 Flash' }
      ]
    },
    deepseek: {
      label: 'DeepSeek',
      models: [
        { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
        { id: 'deepseek/deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision (experimental)' }
      ]
    },
    trending: {
      label: 'Em alta na OpenRouter',
      models: [
        { id: 'x-ai/grok-4.7', name: 'Grok 4.7 (xAI)' },
        { id: 'moonshotai/kimi-k3', name: 'Kimi K3 (Moonshot)' },
        { id: 'qwen/qwen3.8-flash', name: 'Qwen3.8 Flash' },
        { id: 'minimax/minimax-m3', name: 'MiniMax M3' },
        { id: 'z-ai/glm-5.3-flashx', name: 'GLM 5.3 FlashX (Z.ai)' },
        { id: 'mistralai/mistral-large-4-0', name: 'Mistral Large 4' }
      ]
    }
  };


  const DEFAULT_MODEL = 'google/gemini-3.8-flash';
  const MODEL_STORAGE_KEY = STORAGE_PREFIX + 'model';

  // ── fal.ai image/video catalog (Hard Rule #1 BYOK — user's own fal key) ──
  // For tools whose core function is IMAGE or VIDEO generation. fal.ai is NOT
  // routed through OpenRouter — it is a native single-provider key (the `fal`
  // entry in AI_SERVICES). The user pastes their OWN fal.ai key; the company
  // key is never shipped (Rules #1/#7/#12). Call models at:
  //   POST https://fal.run/<model-id>   (Authorization: Key <userFalKey>)
  //
  // ⚠ REFRESH PER BUILD: fal adds models weekly. Before wiring a fal picker,
  // pull the live catalog and bump superseded flagships:
  //   curl "https://api.fal.ai/v1/models?category=text-to-image&limit=20" \
  //        -H "Authorization: Key $userFalKey"
  // (also: text-to-video, image-to-video, image-to-image categories)
  const FAL_MODELS = {
    image: {
      label: 'Imagem (texto → imagem)',
      models: [
        { id: 'fal-ai/flux/schnell', name: 'FLUX.1 [schnell] — rápido/grátis' },
        { id: 'fal-ai/flux/dev', name: 'FLUX.1 [dev] — alta qualidade' },
        { id: 'fal-ai/flux-2-pro', name: 'FLUX.2 [pro] — última geração' },
        { id: 'fal-ai/nano-banana-pro', name: 'Nano Banana Pro (Google)' },
        { id: 'fal-ai/bytedance/seedream/v4', name: 'Seedream 4.0 (ByteDance)' },
        { id: 'fal-ai/recraft/v3/text-to-image', name: 'Recraft V3 — design/vetor' },
        { id: 'fal-ai/ideogram/v3/quality', name: 'Ideogram V3 — tipografia' }
      ]
    },
    imageEdit: {
      label: 'Edição de imagem (imagem → imagem)',
      models: [
        { id: 'fal-ai/nano-banana-pro/edit', name: 'Nano Banana Pro Edit' },
        { id: 'fal-ai/flux-2-pro/edit', name: 'FLUX.2 [pro] Edit' },
        { id: 'fal-ai/flux-pro/kontext', name: 'FLUX.1 Kontext [pro]' },
        { id: 'fal-ai/bria/background/remove', name: 'Remover fundo (BRIA RMBG 2.0)' },
        { id: 'fal-ai/topaz/upscale/image', name: 'Upscale (Topaz)' }
      ]
    },
    video: {
      label: 'Vídeo (texto/imagem → vídeo)',
      models: [
        { id: 'fal-ai/veo3.1/image-to-video', name: 'Veo 3.1 (Google) — SOTA' },
        { id: 'fal-ai/veo3.1/fast/image-to-video', name: 'Veo 3.1 Fast — mais barato' },
        { id: 'fal-ai/sora-2/image-to-video', name: 'Sora 2 (OpenAI)' },
        { id: 'fal-ai/kling-video/v2.6/pro/image-to-video', name: 'Kling V2.6 Pro' },
        { id: 'fal-ai/minimax/hailuo-02/pro/image-to-video', name: 'Hailuo-02 Pro (MiniMax)' }
      ]
    }
  };

  const DEFAULT_FAL_MODEL = 'fal-ai/flux/schnell';
  const FAL_MODEL_STORAGE_KEY = STORAGE_PREFIX + 'fal_model';

  function getModel() {
    try { return localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL; }
    catch { return DEFAULT_MODEL; }
  }

  function setModel(modelId) {
    try { if (modelId) localStorage.setItem(MODEL_STORAGE_KEY, modelId); }
    catch { /* localStorage unavailable */ }
    // COR-055: keep EVERY already-rendered model picker in sync. Generation reads
    // getModel() (localStorage), so a picker left showing an old value (e.g. the
    // studio #model-select after the model is changed in the Gerenciar-chaves modal
    // or on the key screen) would display a model that is NOT the one actually used
    // — a "control doesn't match behaviour" UX bug (COR-041/051 family). Setting
    // .value programmatically does not re-fire 'change', so there is no loop.
    if (modelId) {
      ['model-select', 'key-model-select', 'model-select-modal'].forEach(function(id) {
        var s = document.getElementById(id);
        if (s && s.options && s.options.length && s.value !== modelId) s.value = modelId;
      });
    }
  }

  // Populate a <select> with provider-grouped <optgroup>s.
  function renderModelPicker(selectId) {
    const select = document.getElementById(selectId || 'model-select');
    if (!select) return;
    select.innerHTML = '';
    const current = getModel();
    Object.keys(AI_MODELS).forEach(function(group) {
      const g = AI_MODELS[group];
      const og = document.createElement('optgroup');
      og.label = g.label;
      g.models.forEach(function(m) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        if (m.id === current) opt.selected = true;
        og.appendChild(opt);
      });
      select.appendChild(og);
    });
    select.addEventListener('change', function() { setModel(select.value); });
  }

  // ── fal.ai image/video model selection ──
  function getFalModel() {
    try { return localStorage.getItem(FAL_MODEL_STORAGE_KEY) || DEFAULT_FAL_MODEL; }
    catch { return DEFAULT_FAL_MODEL; }
  }

  function setFalModel(modelId) {
    try { if (modelId) localStorage.setItem(FAL_MODEL_STORAGE_KEY, modelId); }
    catch { /* localStorage unavailable */ }
  }

  // Populate a <select> with fal.ai image/video models, grouped by category.
  // Pass `groups` (e.g. ['image'] or ['video']) to limit which categories show;
  // omit to render all. Use this for tools whose core function is media gen.
  function renderFalModelPicker(selectId, groups) {
    const select = document.getElementById(selectId || 'fal-model-select');
    if (!select) return;
    select.innerHTML = '';
    const current = getFalModel();
    const keys = (groups && groups.length) ? groups : Object.keys(FAL_MODELS);
    keys.forEach(function(group) {
      const g = FAL_MODELS[group];
      if (!g) return;
      const og = document.createElement('optgroup');
      og.label = g.label;
      g.models.forEach(function(m) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        if (m.id === current) opt.selected = true;
        og.appendChild(opt);
      });
      select.appendChild(og);
    });
    select.addEventListener('change', function() { setFalModel(select.value); });
  }

  function getKey(service) {
    try {
      return localStorage.getItem(STORAGE_PREFIX + service) || '';
    } catch {
      return '';
    }
  }

  function setKey(service, key) {
    try {
      if (key) {
        localStorage.setItem(STORAGE_PREFIX + service, key.trim());
      } else {
        localStorage.removeItem(STORAGE_PREFIX + service);
      }
    } catch {
      // localStorage not available
    }
  }

  function clearAllKeys() {
    ENABLED_SERVICES.forEach(function(svc) {
      localStorage.removeItem(STORAGE_PREFIX + svc);
    });
  }

  function hasRequiredKeys() {
    return ENABLED_SERVICES.some(function(svc) {
      const config = AI_SERVICES[svc];
      if (!config) return false;
      return !!getKey(svc);
    });
  }

  function getActiveKey() {
    for (let i = 0; i < ENABLED_SERVICES.length; i++) {
      const key = getKey(ENABLED_SERVICES[i]);
      if (key) return { service: ENABLED_SERVICES[i], key: key, config: AI_SERVICES[ENABLED_SERVICES[i]] };
    }
    return null;
  }

  function renderInputs(containerId) {
    const container = document.getElementById(containerId || 'key-inputs');
    if (!container) return;

    container.innerHTML = '';

    ENABLED_SERVICES.forEach(function(svc) {
      const config = AI_SERVICES[svc];
      if (!config) return;

      const currentKey = getKey(svc);
      const group = document.createElement('div');
      group.className = 'key-input-group';

      const label = document.createElement('label');
      label.setAttribute('for', 'key-' + svc);
      label.textContent = config.name + (config.required ? ' (obrigatório)' : ' (opcional)');

      const wrapper = document.createElement('div');
      wrapper.className = 'key-input-wrapper';

      const input = document.createElement('input');
      input.type = 'password';
      input.id = 'key-' + svc;
      input.placeholder = config.placeholder;
      input.value = currentKey;
      input.autocomplete = 'off';
      input.setAttribute('data-service', svc);

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'key-toggle';
      toggleBtn.textContent = 'Mostrar';
      toggleBtn.addEventListener('click', function() {
        if (input.type === 'password') {
          input.type = 'text';
          toggleBtn.textContent = 'Ocultar';
        } else {
          input.type = 'password';
          toggleBtn.textContent = 'Mostrar';
        }
      });

      const status = document.createElement('div');
      status.className = 'key-status' + (currentKey ? ' saved' : '');
      status.textContent = currentKey ? 'Chave salva localmente' : 'Nenhuma chave configurada';

      input.addEventListener('input', function() {
        const val = input.value.trim();
        setKey(svc, val);
        status.className = 'key-status' + (val ? ' saved' : '');
        status.textContent = val ? 'Chave salva localmente' : 'Nenhuma chave configurada';
        updateContinueButton();
      });

      wrapper.appendChild(input);
      wrapper.appendChild(toggleBtn);
      group.appendChild(label);
      group.appendChild(wrapper);
      group.appendChild(status);
      container.appendChild(group);
    });

    setupKeyScreenButtons();
    updateContinueButton();
  }

  function updateContinueButton() {
    const btn = document.getElementById('key-continue');
    if (btn) btn.disabled = !hasRequiredKeys();
  }

  function setupKeyScreenButtons() {
    const continueBtn = document.getElementById('key-continue');
    const skipBtn = document.getElementById('key-skip');

    if (continueBtn) {
      continueBtn.onclick = function() {
        MembershipGate.showScreen('app-screen');
      };
    }

    if (skipBtn) {
      skipBtn.onclick = function() {
        MembershipGate.showScreen('app-screen');
      };
    }
  }

  function setupModal() {
    const manageBtn = document.getElementById('manage-keys-btn');
    const modal = document.getElementById('key-modal');
    const closeBtn = document.getElementById('modal-close');
    const overlay = modal ? modal.querySelector('.modal-overlay') : null;
    const saveBtn = document.getElementById('modal-save');
    const clearBtn = document.getElementById('modal-clear');

    if (manageBtn && modal) {
      manageBtn.addEventListener('click', function() {
        renderInputs('modal-key-inputs');
        renderModelPicker('model-select-modal'); // no-op if the select is absent (COR-040)
        modal.style.display = 'flex';
      });
    }

    function closeModal() {
      if (modal) modal.style.display = 'none';
    }

    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (overlay) overlay.addEventListener('click', closeModal);

    if (saveBtn) {
      saveBtn.addEventListener('click', closeModal);
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', function() {
        clearAllKeys();
        renderInputs('modal-key-inputs');
      });
    }
  }

  function init() {
    renderInputs('key-inputs');
    renderModelPicker('key-model-select'); // no-op if the select is absent (COR-040)
    setupModal();
  }

  return {
    init: init,
    getKey: getKey,
    setKey: setKey,
    clearAllKeys: clearAllKeys,
    hasRequiredKeys: hasRequiredKeys,
    getActiveKey: getActiveKey,
    renderInputs: renderInputs,
    ENABLED_SERVICES: ENABLED_SERVICES,
    AI_SERVICES: AI_SERVICES,
    AI_MODELS: AI_MODELS,
    getModel: getModel,
    setModel: setModel,
    renderModelPicker: renderModelPicker,
    FAL_MODELS: FAL_MODELS,
    getFalModel: getFalModel,
    setFalModel: setFalModel,
    renderFalModelPicker: renderFalModelPicker
  };
})();

window.ApiKeyManager = ApiKeyManager;

document.addEventListener('DOMContentLoaded', function() {
  ApiKeyManager.init();
});
