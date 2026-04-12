import logging
import sys
# Configure logging format
LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

def setup_logger(name: str):
    """
    Initializes and configures a standardized logger for backend services.

    Args:
        name (str): The name of the logger, typically the __name__ of the module.

    Returns:
        logging.Logger: A configured logger instance that outputs to sys.stdout using the global LOG_FORMAT.
    """

    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)

    # Output to console (standard out)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(LOG_FORMAT))

    if not logger.handlers():
        logger.addHandler(handler)
    return logger