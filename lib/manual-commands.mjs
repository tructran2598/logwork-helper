export const MANUAL_COMMANDS = [
  {
    name: '/help',
    description: 'Show this help',
    usage: '/help',
    aliases: []
  },
  {
    name: '/auth',
    description: 'Run Resource Optimiser API auth',
    usage: '/auth',
    aliases: []
  },
  {
    name: '/status',
    description: 'Show stored auth status',
    usage: '/status',
    aliases: []
  },
  {
    name: '/query',
    description: 'Query logwork by day or range',
    usage: '/query today | this-week | YYYY-MM-DD | YYYY-MM-DD..YYYY-MM-DD',
    aliases: []
  },
  {
    name: '/logwork',
    description: 'Create logwork with date/project/task wizard',
    usage: '/logwork',
    aliases: []
  },
  {
    name: '/apply',
    description: 'Apply the last preview after confirmation',
    usage: '/apply',
    aliases: [],
    hidden: true
  },
  {
    name: '/projects',
    description: 'List projects with weekly booked/logged chart',
    usage: '/projects [projectMemberId|projectId|name]',
    aliases: []
  },
  {
    name: '/map',
    description: 'Map ticket prefix to projectMemberId',
    usage: '/map SCB 5234',
    aliases: []
  }
];

export const TASK_COMMANDS = [
  {
    name: '/save',
    description: 'Save this draft locally',
    usage: '/save',
    aliases: []
  },
  {
    name: '/drafts',
    description: 'Resume or delete saved drafts',
    usage: '/drafts',
    aliases: []
  },
  {
    name: '/remove',
    description: 'Select tasks to delete',
    usage: '/remove',
    aliases: []
  },
  {
    name: '/edit',
    description: 'Select one task and replace it',
    usage: '/edit',
    aliases: []
  },
  {
    name: '/clear',
    description: 'Clear current task list',
    usage: '/clear',
    aliases: []
  },
  {
    name: '/back',
    description: 'Return to project picker',
    usage: '/back',
    aliases: []
  },
  {
    name: '/cancel',
    description: 'Discard this logwork session',
    usage: '/cancel',
    aliases: ['/discard']
  }
];

export function formatManualHelp(commands = MANUAL_COMMANDS) {
  const visibleCommands = commands.filter((command) => command.hidden !== true);
  return [
    'Commands:',
    ...visibleCommands.map((command) => `  ${command.usage.padEnd(36)} ${command.description}`)
  ].join('\n');
}

export function findManualCommand(name, commands = MANUAL_COMMANDS) {
  const normalized = String(name || '').toLowerCase();
  return commands.find((command) => (
    command.name === normalized ||
    command.aliases.includes(normalized)
  ));
}

export function getCommandSuggestions(buffer, commands = MANUAL_COMMANDS) {
  const value = String(buffer || '');
  if (!value.startsWith('/')) {
    return [];
  }

  if (/^\S+\s/.test(value)) {
    return [];
  }

  const commandPart = value.split(/\s+/, 1)[0].toLowerCase();
  if (!commandPart) {
    return [];
  }

  return commands.filter((command) => command.hidden !== true && command.name.startsWith(commandPart));
}

export function renderCommandSuggestions(buffer, selectedIndex = 0, commands = MANUAL_COMMANDS) {
  const suggestions = getCommandSuggestions(buffer, commands);
  if (!suggestions.length) {
    return '';
  }

  return suggestions
    .slice(0, 6)
    .map((command, index) => {
      const marker = index === selectedIndex ? '›' : ' ';
      return `${marker} ${command.name.padEnd(12)} ${command.description}`;
    })
    .join('\n');
}
