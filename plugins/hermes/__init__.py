"""Where: plugins/hermes/__init__.py
What: Hermes plugin entrypoint shim for the Kinic adapter package.
Why: Hermes loads register(ctx) from the plugin root __init__.py.
"""

from .kinic_hermes import register

__all__ = ["register"]
