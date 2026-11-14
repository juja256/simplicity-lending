import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'intro',
    'simplicity',
    {
      type: 'category',
      label: 'Private loans',
      items: ['private-loans/guide', 'private-loans/protocol'],
    },
    {
      type: 'category',
      label: 'Contracts',
      link: {
        type: 'generated-index',
        title: 'Contracts',
        description:
          'The two helper programs that guard outputs of a private loan, and what each one checks before it lets an output be spent. The private lending contract itself is described under Private loans.',
        slug: '/contracts',
      },
      items: [
        {type: 'doc', id: 'contracts/asset-auth', label: '🔑 Asset auth'},
        {type: 'doc', id: 'contracts/script-auth', label: '📜 Script auth'},
      ],
    },
    {
      type: 'category',
      label: 'Developers',
      items: [
        {type: 'doc', id: 'developers/versions', label: '🏷️ Versions'},
        {type: 'doc', id: 'developers/build', label: '🔨 Build'},
        {type: 'doc', id: 'developers/docker', label: '🐳 Run with Docker'},
        {type: 'doc', id: 'developers/local-setup', label: '💻 Run locally'},
      ],
    },
  ],
};

export default sidebars;
