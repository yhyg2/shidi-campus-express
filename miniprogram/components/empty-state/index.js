Component({
  properties: {
    icon: { type: String, value: '◌' },
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    actionText: { type: String, value: '' }
  },
  methods: {
    onAction() { this.triggerEvent('action'); }
  }
});
