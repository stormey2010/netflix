/**
 * Netflix Connect - Setup
 * Profile picker; stores the chosen user in chrome.storage.sync.
 */

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #e50914, #8f0610)',
  'linear-gradient(135deg, #6d5df6, #3d2f9e)',
];

function buildProfiles(selectedUser) {
  const container = document.getElementById('profiles');
  container.innerHTML = '';

  NC_CONFIG.USERS.forEach((name) => {
    const btn = document.createElement('button');
    btn.className = 'profile' + (name === selectedUser ? ' selected' : '');
    btn.innerHTML = `
      <div class="profile-avatar">${name[0]}</div>
      <span class="profile-name">${name}</span>
    `;
    btn.addEventListener('click', () => selectUser(name));
    container.appendChild(btn);
  });
}

async function selectUser(name) {
  document.querySelectorAll('.profile').forEach((p) => {
    p.classList.toggle('selected', p.querySelector('.profile-name').textContent === name);
  });

  await chrome.storage.sync.set({ user: name });

  setTimeout(() => {
    const idx = NC_CONFIG.USERS.indexOf(name);
    const partner = NC_CONFIG.USERS.find((u) => u !== name);
    const avatar = document.getElementById('successAvatar');
    avatar.textContent = name[0];
    avatar.style.background = AVATAR_GRADIENTS[Math.max(0, idx)];
    document.getElementById('successSub').textContent = `Ready to watch together with ${partner}`;
    document.getElementById('stage').classList.add('done');
    document.getElementById('success').classList.add('visible');
  }, 250);
}

document.getElementById('closeBtn').addEventListener('click', () => window.close());

chrome.storage.sync.get(['user']).then((res) => buildProfiles(res.user || null));
